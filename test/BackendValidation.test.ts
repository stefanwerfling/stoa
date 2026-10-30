import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

// Trust-boundary rule R-VALIDATION-MISSING-BACKEND, exercised through the real
// analysis path. The TypeScript adapter is synchronous (ts-morph), so no grammar
// init is needed here.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const fixtures = join(here, 'fixtures', 'backend-validation');

const analyzeFixture = (file: string): Finding[] => {
    return analyze({rootPath: join(fixtures, file), knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).report.findings;
};
const byRule = (findings: Finding[], ruleId: string): Finding[] => findings.filter((f) => f.rule.id === ruleId);
const rule = (findings: Finding[]): Finding[] => byRule(findings, 'R-VALIDATION-MISSING-BACKEND');
const massAssignment = (findings: Finding[]): Finding[] => byRule(findings, 'R-VALIDATION-MASS-ASSIGNMENT');

test('flags handlers that read req.body / req.query without recognized validation', () => {
    const findings = rule(analyzeFixture('unvalidated.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`).sort(),
        ['14:req.query', '7:req.body'],
        'the body-persisting POST and the query-using GET are both flagged with their input source'
    );
    const first = findings[0];
    assert.equal(first?.rule.id, 'R-VALIDATION-MISSING-BACKEND');
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(first?.interpretation.dimensions.includes('robustness'));
    assert.equal(first?.certaintyBasis, 'semantic-heuristic', 'reported as a heuristic risk, not a syntactic certainty');
});

test('does not flag handlers that validate via Zod, vts, a manual 400 guard, a route schema, or read only params', () => {
    const findings = rule(analyzeFixture('validated.ts'));
    assert.deepEqual(findings, [], 'all recognized validation styles suppress the finding; params are out of scope');
});

test('mass assignment: flags Object.assign, a direct persistence call and a spread persistence call fed the raw request payload', () => {
    const findings = massAssignment(analyzeFixture('mass-assignment.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`),
        ['9:Object.assign(…, req.body)', '15:save(req.body)', '21:update({...(req.body as Record<string, unknown>)})']
    );
    const first = findings[0];
    assert.equal(first?.interpretation.principles[0]?.id, 'marcus.judgment');
    assert.ok(first?.interpretation.dimensions.includes('robustness'));
    assert.equal(first?.severity, 'high');
    assert.equal(first?.certaintyBasis, 'semantic-heuristic');
});

test('mass assignment: still flags a raw alias reaching save() even when the handler itself rejects malformed input, but not an allow-listed object', () => {
    // /vts2 and /manual both satisfy R-VALIDATION-MISSING-BACKEND (they reject bad
    // input), but neither narrows the saved value's shape — the two concerns are
    // independent, and the raw object still carries any unchecked extra property.
    // /zod, /vts and /schema narrow via a validator/route schema; /allowlist reads
    // only body.name into a fresh literal (a single-field pluck, no alias, no spread);
    // /boundAlias narrows via the .bind()-alias validator (see the next test group).
    const findings = massAssignment(analyzeFixture('validated.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`),
        ['47:save(body)', '54:save(body)']
    );
});

test('correctness fix: a throw gated by a condition unrelated to the request (a DB-lookup result) is not treated as input validation', () => {
    // The exact bug reported: previously ANY throw anywhere in the handler counted
    // as evidence of a validation guard, so `if (!user) throw ...` (user is a DB
    // lookup, unrelated to req.body) wrongly suppressed this finding.
    const findings = rule(analyzeFixture('unrelated-throw.ts'));
    assert.deepEqual(
        findings.map((f) => `${f.location.range.startLine}:${f.observation.evidence[0]?.value}`),
        ['17:req.body'],
        'only createUserUnrelatedThrow is flagged; the direct- and aliased-guard functions correctly count as validated'
    );
});

test('correctness fix: a throw genuinely gated by a condition on the request (direct, or via a strict whole-object alias) still counts as validated', () => {
    const findings = rule(analyzeFixture('unrelated-throw.ts'));
    assert.ok(!findings.some((f) => f.location.range.startLine === 26), 'createUserDirectGuard: if (!req.body.name) throw — a genuine input check');
    assert.ok(!findings.some((f) => f.location.range.startLine === 37), 'createUserAliasedGuard: const body = req.body; if (!body.name) throw — still genuine despite the alias');
});

test('AST relationship, not a name heuristic: a .bind() validator alias whose own name would not match the VALIDATOR_NAME pattern is still recognized', () => {
    // boundValidate = ItemSchema.safeParse.bind(ItemSchema); its name does not
    // start with validate/parse/assert/ensure/check/guard, so only the verified
    // AST relationship (not a name match) can recognize /boundAlias as validated —
    // already covered by the "does not flag..." test asserting the whole file is
    // clean; this test documents specifically WHY that holds for /boundAlias.
    const findings = rule(analyzeFixture('validated.ts'));
    assert.deepEqual(findings, [], '/boundAlias (and every other handler in this fixture) is correctly recognized as validated');
});

test('mass assignment extension: a direct property assignment (not a const alias) still taints the object it writes into', () => {
    // /direct-assignment: entity.data = req.body; repo.save(entity) — entity
    // was never declared as `= req.body`, only ONE of its properties was
    // assigned from it, yet the whole object is later saved.
    const findings = massAssignment(analyzeFixture('mass-assignment-extended.ts'));
    const hit = findings.find((f) => f.location.range.startLine === 31);
    assert.ok(hit, '/direct-assignment: save(entity) is flagged even though entity was never a `const x = req.body` alias');
    assert.equal(hit?.observation.evidence[0]?.value, 'save(entity)');
});

test('mass assignment extension: a raw payload passed through one cross-function hop to a persistence call is still flagged', () => {
    // /one-hop: userService.register(req.body) — register's own name gives
    // no hint, but resolving one hop into its body shows it ultimately calls
    // this.repository.save(data), the raw-value mirror of
    // ValidationDataflow.ts's one-hop trace for a VALIDATED value.
    const findings = massAssignment(analyzeFixture('mass-assignment-extended.ts'));
    const hit = findings.find((f) => f.location.range.startLine === 39);
    assert.ok(hit, '/one-hop: the raw payload reaching a sink through UserService.register is flagged');
    assert.equal(hit?.observation.evidence[0]?.value, 'userService.register(req.body) → this.repository.save(data) inside UserService.register');
});

test('mass assignment extension: the narrow ORM "merge" verb addition is recognized, but a single plucked field through a direct assignment is still out of scope', () => {
    // /merge: repo.merge(entity, req.body) — TypeORM-style merge copying the
    // raw payload onto entity. /single-field-assignment: entity.data = a
    // SINGLE plucked field (not the whole raw payload) — the existing
    // single-field scope restriction still applies; no finding.
    const findings = massAssignment(analyzeFixture('mass-assignment-extended.ts'));
    assert.ok(findings.some((f) => f.location.range.startLine === 47 && f.observation.evidence[0]?.value === 'merge(req.body)'));
    assert.ok(!findings.some((f) => f.location.range.startLine >= 54 && f.location.range.startLine <= 58), '/single-field-assignment: a single plucked field is not a mass-assignment risk');
});
