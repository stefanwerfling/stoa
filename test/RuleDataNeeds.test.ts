import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadArchitectureConfig, ArchitectureModel} from '../src/architecture/ArchitectureConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyzeAsync, type AnalyzeAsyncOptions} from '../src/Pipeline.js';
import {DeadExportRule} from '../src/rules/project/DeadExportRule.js';
import {DependencyCycleRule} from '../src/rules/project/DependencyCycleRule.js';
import {flutterLayoutRules} from '../src/rules/project/FlutterLayoutRules.js';
import {flutterLifecycleRules} from '../src/rules/project/FlutterLifecycleRules.js';
import {solidRules} from '../src/rules/project/SolidRules.js';
import {ValidationContractRule} from '../src/rules/project/ValidationContractRule.js';
import type {ProjectRule, ProjectRuleInput} from '../src/rules/ProjectRule.js';
import {RuleEngine} from '../src/rules/RuleEngine.js';
import {RuleSet} from '../src/rules/RuleSet.js';
import type {Fact, Finding} from '../src/Types.js';

// Phase 4 of the quality-hardening spec: which data each rule actually
// needs. Measured, not declared — every project rule's input is wrapped in a
// recording proxy while the real pipeline runs over fixtures that take each
// rule past its early exits; the fields it read decide its class:
//   local    — the 40 declarative rules: one subject's facts, one file
//   module   — reads the ModuleGraph (and no SymbolGraph/TypeModel)
//   symbol   — reads the SymbolGraph/TypeModel, or the DartLibraryIndex
//              without the ModuleGraph (cross-file name resolution)
//   project  — reads neither: the whole fact set or the widget graph
// It also proves what a bounded evaluation would rely on: the declarative
// rules are file-local (per-file evaluation = whole evaluation), and the
// project rules are independent of one another (order, alone vs. together)
// and never mutate their input.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeBase = KnowledgeBase.loadFromDirectory(join(root, 'knowledge', 'marcus'), DEFAULT_CONFIG.knowledgeBase);
const ruleSet = RuleSet.loadFromDirectory(join(root, 'rules', 'default'), DEFAULT_CONFIG.ruleSet);

const options = (path: string, extra: Partial<AnalyzeAsyncOptions> = {}): AnalyzeAsyncOptions => ({
    rootPath: join(root, path),
    knowledgeDir: join(root, 'knowledge', 'marcus'),
    ruleSetDir: join(root, 'rules', 'default'),
    config: DEFAULT_CONFIG,
    solid: true,
    deadExports: true,
    ...extra
});

/** Runs that take every registered project rule past its early exits (each rule finds something in at least one). */
const runs = (): AnalyzeAsyncOptions[] => [
    options('test/corpus/project'),
    options('test/corpus/solid/project'),
    options('test/corpus/solid/project', {architecture: loadArchitectureConfig(join(root, 'test/corpus/solid/stoa.architecture.json'))}),
    options('test/fixtures/flutter-lifecycle'),
    options('test/fixtures/flutter-layout'),
    options('test/fixtures/dart-layers'),
    options('test/fixtures/validation-contract', {validationContract: loadValidationContract(join(root, 'test/fixtures/validation-contract/contract.json'))})
];

/** Every project rule the pipeline can register (SOLID with and without an architecture config). */
const registeredRules = (): ProjectRule[] => [
    new DependencyCycleRule(),
    new DeadExportRule(),
    new ValidationContractRule(null),
    ...flutterLayoutRules(),
    ...flutterLifecycleRules(),
    ...solidRules(),
    ...solidRules(new ArchitectureModel(loadArchitectureConfig(join(root, 'test/corpus/solid/stoa.architecture.json')), root))
];

/** Fields every rule reads to build a finding — not data. */
const BOOKKEEPING = new Set(['ruleSetId', 'lang', 'knowledgeBase']);

type RuleClass = 'module' | 'symbol' | 'project';

const classOf = (fields: ReadonlySet<string>): RuleClass => {
    if (fields.has('symbolGraph') || fields.has('typeModel') || (fields.has('dartLibraryIndex') && !fields.has('moduleGraph'))) {
        return 'symbol';
    }
    return fields.has('moduleGraph') ? 'module' : 'project';
};

// Measured on the runs above (class name → fields read, besides the bookkeeping ones).
const EXPECTED: Record<string, {class: RuleClass; fields: string[]}> = {
    DependencyCycleRule: {class: 'module', fields: ['moduleGraph']},
    SolidDipLayerDirectionRule: {class: 'module', fields: ['dartLibraryIndex', 'facts', 'moduleGraph']},
    SolidDipLayerDeclaredRule: {class: 'module', fields: ['moduleGraph']},
    SolidLspContractCompatibilityRule: {class: 'symbol', fields: ['analyzedFiles', 'dartLibraryIndex', 'facts', 'moduleGraph', 'symbolGraph', 'typeModel']},
    SolidIspInterfaceCohesionRule: {class: 'symbol', fields: ['analyzedFiles', 'dartLibraryIndex', 'facts', 'moduleGraph', 'symbolGraph', 'typeModel']},
    SolidDipConcreteDependencyRule: {class: 'symbol', fields: ['dartLibraryIndex', 'facts', 'moduleGraph', 'symbolGraph', 'typeModel']},
    FlutterUndisposedControllerRule: {class: 'symbol', fields: ['dartLibraryIndex', 'facts', 'identityScheme']},
    FlutterUncancelledSubscriptionRule: {class: 'symbol', fields: ['dartLibraryIndex', 'facts', 'identityScheme']},
    FlutterSetStateAfterAwaitRule: {class: 'symbol', fields: ['dartLibraryIndex', 'facts', 'identityScheme']},
    FlutterInheritedInInitStateRule: {class: 'symbol', fields: ['dartLibraryIndex', 'facts', 'identityScheme']},
    FlutterParentDataMisuseRule: {class: 'project', fields: ['flutterWidgetGraph']},
    FlutterUnboundedScrollableRule: {class: 'project', fields: ['flutterWidgetGraph']},
    FlutterTextFieldInRowRule: {class: 'project', fields: ['flutterWidgetGraph']},
    FlutterNestedScrollRule: {class: 'project', fields: ['flutterWidgetGraph']},
    DeadExportRule: {class: 'project', fields: ['analyzedFiles', 'facts']},
    ValidationContractRule: {class: 'project', fields: ['facts']}
};

const recorded = new Map<string, Set<string>>();
const produced = new Map<string, number>();
const restore: Array<() => void> = [];

before(() => {
    // Wraps each rule class's `evaluate` (on the prototype that defines it)
    // so the pipeline's own instances record what they read.
    const wrapped = new Set<object>();
    for (const rule of registeredRules()) {
        let owner: object | null = Object.getPrototypeOf(rule) as object | null;
        while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'evaluate')) {
            owner = Object.getPrototypeOf(owner) as object | null;
        }
        if (owner === null || wrapped.has(owner)) {
            continue;
        }
        wrapped.add(owner);
        const original: unknown = Reflect.get(owner, 'evaluate');
        if (typeof original !== 'function') {
            continue;
        }
        const target = owner;
        Reflect.set(target, 'evaluate', function (this: ProjectRule, input: ProjectRuleInput): Finding[] {
            const name = this.constructor.name;
            const fields = recorded.get(name) ?? new Set<string>();
            recorded.set(name, fields);
            const proxy = new Proxy(input, {
                get: (object, key, receiver): unknown => {
                    if (typeof key === 'string' && !BOOKKEEPING.has(key)) {
                        fields.add(key);
                    }
                    return Reflect.get(object, key, receiver);
                }
            });
            const findings = Reflect.apply(original, this, [proxy]) as Finding[];
            produced.set(name, (produced.get(name) ?? 0) + findings.length);
            return findings;
        });
        restore.push(() => Reflect.set(target, 'evaluate', original));
    }
});

after(() => {
    for (const undo of restore) {
        undo();
    }
});

test('every project rule reads exactly the data of its class (recorded through the real pipeline)', async () => {
    for (const run of runs()) {
        await analyzeAsync(run);
    }
    const actual = Object.fromEntries([...recorded].map(([name, fields]) => [name, {class: classOf(fields), fields: [...fields].sort()}]));
    assert.deepEqual(actual, EXPECTED);
    // Each rule got past its early exits somewhere — otherwise its record
    // would only say what it reads to decide it has nothing to do.
    for (const name of Object.keys(EXPECTED).filter((candidate) => candidate !== 'SolidDipLayerDeclaredRule')) {
        assert.ok((produced.get(name) ?? 0) > 0, `${name} produced no finding on the runs`);
    }
});

const factsOf = async (path: string, extra: Partial<AnalyzeAsyncOptions> = {}): Promise<Fact[]> => (await analyzeAsync(options(path, {solid: false, deadExports: false, ...extra}))).facts;

/** A finding list as comparable text, in its own order. */
const text = (findings: readonly Finding[]): string[] => findings.map((finding) => JSON.stringify(finding));

test('declarative rules are file-local: evaluating each file on its own yields the same findings as the whole fact set', async () => {
    const engine = new RuleEngine(knowledgeBase, ruleSet, 'en', []);
    for (const path of ['test/corpus/project', 'test/fixtures/flutter/corpus', 'test/fixtures/cpp', 'test/fixtures/php', 'test/fixtures/html/corpus', 'test/fixtures/vue/corpus']) {
        const facts = await factsOf(path);
        const whole = engine.evaluate(facts);
        assert.ok(whole.length > 0, `${path}: no declarative finding to compare`);
        const files = [...new Set(facts.map((fact) => fact.subject.file))];
        const perFile = files.flatMap((file) => engine.evaluate(facts.filter((fact) => fact.subject.file === file)));
        assert.deepEqual(text(perFile).sort(), text(whole).sort(), path);
    }
});

test('project rules are independent: alone, together and in reverse order they report the same, and none mutates the facts', async () => {
    const facts = await factsOf('test/corpus/project');
    const dartFacts = await factsOf('test/fixtures/flutter-lifecycle');
    const all = [...facts, ...dartFacts];
    const rules = (): ProjectRule[] => [new DependencyCycleRule(), new DeadExportRule(), ...flutterLifecycleRules(), ...solidRules()];
    const freeze = (value: unknown): void => {
        if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const nested of Object.values(value)) {
                freeze(nested);
            }
        }
    };
    const frozen = structuredClone(all);
    freeze(frozen);
    // A rule that wrote to a fact would throw here (ES modules are strict).
    const together = new RuleEngine(knowledgeBase, ruleSet, 'en', rules()).evaluate(frozen);
    const reversed = new RuleEngine(knowledgeBase, ruleSet, 'en', rules().reverse()).evaluate(structuredClone(all));
    assert.deepEqual(text(reversed), text(together));
    const declarative = new Set(text(new RuleEngine(knowledgeBase, ruleSet, 'en', []).evaluate(structuredClone(all))));
    const projectFindings = text(together).filter((finding) => !declarative.has(finding));
    assert.ok(projectFindings.length > 0);
    const alone = rules().flatMap((rule) => text(new RuleEngine(knowledgeBase, ruleSet, 'en', [rule]).evaluate(structuredClone(all))).filter((finding) => !declarative.has(finding)));
    assert.deepEqual(alone.sort(), [...projectFindings].sort());
});
