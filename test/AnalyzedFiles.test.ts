import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';
import {DependencyCycleRule} from '../src/rules/project/DependencyCycleRule.js';
import type {ProjectRule, ProjectRuleInput} from '../src/rules/ProjectRule.js';
import {RuleEngine} from '../src/rules/RuleEngine.js';
import {RuleSet} from '../src/rules/RuleSet.js';
import type {Fact} from '../src/Types.js';

// Phase 3 of the evaluator-integrity track: `analyzedFiles` is the run's
// explicit list of analyzed files, handed from the pipeline through the
// RuleEngine to every project rule — never re-derived from the facts.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let work: string;

before(() => {
    work = mkdtempSync(join(tmpdir(), 'stoa-analyzed-files-'));
    writeFileSync(join(work, 'a.ts'), "import {b} from './b';\nexport const a = b;\n");
    writeFileSync(join(work, 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(work, 'c.ts'), 'export const c = 2;\n');
});

after(() => {
    rmSync(work, {recursive: true, force: true});
});

const factOf = (file: string, kind: string): Fact => ({
    id: `${file}:${kind}`,
    kind,
    subject: {file, kindOf: 'file', range: {startLine: 1, startCol: 0, endLine: 1, endCol: 0}},
    value: 1,
    evidence: [],
    certainty: 'syntactic',
    producedBy: {adapter: 'test', version: '0'}
});

/** A rule that records the `analyzedFiles` it is given. */
const spyRule = (seen: ReadonlySet<string>[]): ProjectRule => ({
    id: 'SPY',
    version: '0',
    evaluate: (input: ProjectRuleInput) => {
        seen.push(input.analyzedFiles);
        return [];
    }
});

const engineWith = (rule: ProjectRule): RuleEngine =>
    new RuleEngine(KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase), RuleSet.loadFromDirectory(ruleSetDir, DEFAULT_CONFIG.ruleSet), 'en', [rule]);

test('RuleEngine hands the given analyzedFiles to project rules as is — a file without any fact stays', () => {
    const seen: ReadonlySet<string>[] = [];
    const files = new Set(['/p/a.ts', '/p/empty.ts']);
    engineWith(spyRule(seen)).evaluate([factOf('/p/a.ts', 'file.lineCount')], undefined, undefined, undefined, undefined, files);
    assert.equal(seen[0], files);
    assert.deepEqual([...(seen[0] ?? [])], ['/p/a.ts', '/p/empty.ts']);
});

test('a filtered fact set does not shrink the file inventory: the rule still sees every analyzed file', () => {
    const seen: ReadonlySet<string>[] = [];
    const facts = [factOf('/p/a.ts', 'deps.import'), factOf('/p/b.ts', 'file.lineCount')];
    const files = new Set(['/p/a.ts', '/p/b.ts']);
    const onlyImports = facts.filter((fact) => fact.kind === 'deps.import');
    engineWith(spyRule(seen)).evaluate(onlyImports, undefined, undefined, undefined, undefined, files);
    assert.deepEqual([...(seen[0] ?? [])].sort(), ['/p/a.ts', '/p/b.ts']);
});

test('compatibility: without analyzedFiles the RuleEngine falls back to the files of the facts (callers without a file list)', () => {
    const seen: ReadonlySet<string>[] = [];
    engineWith(spyRule(seen)).evaluate([factOf('/p/a.ts', 'file.lineCount'), factOf('/p/b.ts', 'file.lineCount'), factOf('/p/a.ts', 'deps.import')]);
    assert.deepEqual([...(seen[0] ?? [])].sort(), ['/p/a.ts', '/p/b.ts']);
});

test('pipeline: rules receive exactly the ModuleGraph node set (the explicit file list), and an unreadable file is not in it', {skip: process.getuid?.() === 0 ? 'root can read a chmod 000 file' : false}, () => {
    const seen: {files: string[]; nodes: readonly string[]}[] = [];
    // Observe the real pipeline wiring through a rule it always registers.
    const original = DependencyCycleRule.prototype.evaluate;
    DependencyCycleRule.prototype.evaluate = function (this: DependencyCycleRule, input: ProjectRuleInput) {
        seen.push({files: [...input.analyzedFiles].sort(), nodes: input.moduleGraph?.nodes ?? []});
        return original.call(this, input);
    };
    const unreadable = join(work, 'c.ts');
    chmodSync(unreadable, 0o000);
    try {
        const result = analyze({rootPath: work, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
        assert.equal(result.report.coverage.status, 'partial');
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0]?.files, [join(work, 'a.ts'), join(work, 'b.ts')]);
        assert.deepEqual(seen[0]?.files, [...(seen[0]?.nodes ?? [])]);
    } finally {
        chmodSync(unreadable, 0o644);
        DependencyCycleRule.prototype.evaluate = original;
    }
});
