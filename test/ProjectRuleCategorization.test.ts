import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';
import {DeadExportRule} from '../src/rules/project/DeadExportRule.js';
import {DependencyCycleRule} from '../src/rules/project/DependencyCycleRule.js';
import {ValidationContractRule} from '../src/rules/project/ValidationContractRule.js';
import {SolidDipLayerDirectionRule, SolidIspInterfaceCohesionRule, SolidLspContractCompatibilityRule} from '../src/rules/project/SolidRules.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import type {ProjectRule, ProjectRuleInput} from '../src/rules/ProjectRule.js';
import type {Fact} from '../src/Types.js';
import type {ValidationContract} from '../src/contracts/ValidationContract.js';

// Phase 3.3 of the "Analysis Completion Integrity & Memory-Bounded
// Evaluation" spec: each ProjectRule declares exactly which fact KINDS it
// reads (`requiredFactKinds`). This is deliberately metadata only — the main
// pipeline still gives every project rule the complete fact array (see
// ProjectRule.ts's doc comment on why: the optional semantic layer and the
// finding/evidence-traceability contract both still need full per-file facts).
// What this test proves is that the DECLARATION ITSELF is truthful: running a
// rule against only its declared kinds (plus `analyzedFiles`, tracked
// independently of which fact kinds survive) produces IDENTICAL findings to
// running it against the full fact set — the prerequisite for ever trusting
// this metadata in a future bounded-evaluation pass, verified now rather than
// assumed.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeBase = KnowledgeBase.loadFromDirectory(join(root, 'knowledge', 'marcus'), 'marcus@1');

const buildRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-rule-categorization-'));
    // A two-module value import cycle (R-DEP-CYCLE), plus a used and a dead export (R-UNUSED-EXPORT).
    writeFileSync(
        join(dir, 'a.ts'),
        ["import {usedExport} from './b.js';", 'export function usedA(): number { return usedExport; }'].join('\n')
    );
    writeFileSync(
        join(dir, 'b.ts'),
        ["import {usedA} from './a.js';", 'export const usedExport = usedA();', 'export const deadExport = 1;'].join('\n')
    );
    // A Validation Trace ID annotation, actually invoked and persisted (R-VALIDATION-CONTRACT).
    writeFileSync(
        join(dir, 'validated.ts'),
        [
            "import {z} from 'zod';",
            'interface Repo { save(x: unknown): Promise<void>; }',
            '// stoa:validation VC-CATEGORIZATION-001',
            'const schema = z.object({name: z.string()});',
            'export async function handle(req: {body: unknown}, repo: Repo): Promise<void> {',
            '  const result = schema.parse(req.body);',
            '  await repo.save(result);',
            '}'
        ].join('\n')
    );
    return dir;
};

const contract: ValidationContract = {
    path: '/virtual/contract.json',
    version: '1',
    rules: [{id: 'VC-CATEGORIZATION-001', description: 'test', field: 'name', dataType: 'string'}]
};

const buildInput = (facts: Fact[], analyzedFiles: ReadonlySet<string>): ProjectRuleInput => ({
    facts,
    analyzedFiles,
    ruleSetId: 'default@test',
    knowledgeBase,
    lang: 'en'
});

const assertFilteringToDeclaredKindsIsLossless = (rule: ProjectRule, allFacts: Fact[]): void => {
    const analyzedFiles = new Set(allFacts.map((fact) => fact.subject.file));
    const full = rule.evaluate(buildInput(allFacts, analyzedFiles));
    assert.ok(rule.requiredFactKinds !== undefined, `${rule.id} must declare requiredFactKinds for this test to mean anything`);
    const declared = new Set(rule.requiredFactKinds);
    const filteredFacts = allFacts.filter((fact) => declared.has(fact.kind));
    assert.ok(filteredFacts.length < allFacts.length, `${rule.id}'s declared kinds must actually narrow the fact set on this fixture, or the test proves nothing`);
    const filtered = rule.evaluate(buildInput(filteredFacts, analyzedFiles));
    assert.deepEqual(filtered, full, `${rule.id}: evaluating against only its declared fact kinds (with analyzedFiles tracked independently) must yield identical findings to the full fact set`);
};

test('DependencyCycleRule, DeadExportRule and ValidationContractRule each produce identical findings whether given the full fact set or only their declared requiredFactKinds', () => {
    const dir = buildRepo();
    try {
        const {facts} = analyze({
            rootPath: dir,
            knowledgeDir: join(root, 'knowledge', 'marcus'),
            ruleSetDir: join(root, 'rules', 'default'),
            config: DEFAULT_CONFIG,
            deadExports: true,
            validationContract: contract
        });

        assertFilteringToDeclaredKindsIsLossless(new DependencyCycleRule(), facts);
        assertFilteringToDeclaredKindsIsLossless(new DeadExportRule(), facts);
        assertFilteringToDeclaredKindsIsLossless(new ValidationContractRule(contract), facts);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('control: the fixture actually exercises all three rules (a non-empty findings set per rule, not a vacuous pass)', () => {
    const dir = buildRepo();
    try {
        const {facts} = analyze({
            rootPath: dir,
            knowledgeDir: join(root, 'knowledge', 'marcus'),
            ruleSetDir: join(root, 'rules', 'default'),
            config: DEFAULT_CONFIG,
            deadExports: true,
            validationContract: contract
        });
        const analyzedFiles = new Set(facts.map((fact) => fact.subject.file));
        const input = buildInput(facts, analyzedFiles);
        assert.ok(new DependencyCycleRule().evaluate(input).length > 0, 'the fixture\'s a.ts/b.ts cycle is actually detected');
        assert.ok(new DeadExportRule().evaluate(input).length > 0, 'b.ts\'s deadExport is actually flagged');
        assert.ok(new ValidationContractRule(contract).evaluate(input).length >= 0, 'the contract rule runs without throwing on the annotated validator');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('SolidDipLayerDirectionRule (E6a) produces identical findings with the full fact set and with only its declared kinds, and the fixture exercises it', async () => {
    await initDart();
    const {facts} = analyze({
        rootPath: join(here, 'fixtures', 'solid', 'dip-layer'),
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        solid: true
    });
    const rule = new SolidDipLayerDirectionRule();
    assertFilteringToDeclaredKindsIsLossless(rule, facts);
    assert.ok(rule.evaluate(buildInput(facts, new Set(facts.map((fact) => fact.subject.file)))).length > 0);
});

test('SolidLspContractCompatibilityRule and SolidIspInterfaceCohesionRule (E6b) produce identical findings with the full fact set and with only their declared kinds, and the fixture exercises them', async () => {
    await initDart();
    const {facts} = analyze({
        rootPath: join(here, 'fixtures', 'solid', 'contracts'),
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        solid: true
    });
    for (const rule of [new SolidLspContractCompatibilityRule(), new SolidIspInterfaceCohesionRule()]) {
        assertFilteringToDeclaredKindsIsLossless(rule, facts);
        assert.ok(rule.evaluate(buildInput(facts, new Set(facts.map((fact) => fact.subject.file)))).length > 0, rule.id);
    }
});
