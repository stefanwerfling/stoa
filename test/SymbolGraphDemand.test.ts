import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {flutterAwareIndex} from '../src/analysis/dart/FlutterCatalog.js';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {loadArchitectureConfig, ArchitectureModel} from '../src/architecture/ArchitectureConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {EMPTY_PROJECT_CONFIG} from '../src/config/ProjectConfig.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {buildModuleGraph} from '../src/model/ModuleGraph.js';
import {buildSymbolGraph} from '../src/model/SymbolGraph.js';
import {analyze} from '../src/Pipeline.js';
import {needsSymbolGraph, type ProjectRule, type ProjectRuleInput} from '../src/rules/ProjectRule.js';
import {DeadExportRule} from '../src/rules/project/DeadExportRule.js';
import {DependencyCycleRule} from '../src/rules/project/DependencyCycleRule.js';
import {flutterLayoutRules} from '../src/rules/project/FlutterLayoutRules.js';
import {flutterLifecycleRules} from '../src/rules/project/FlutterLifecycleRules.js';
import {SolidLspContractCompatibilityRule, solidRules} from '../src/rules/project/SolidRules.js';
import {SolidSrpResponsibilityCohesionRule} from '../src/rules/project/SolidSrpRule.js';
import type {Fact} from '../src/Types.js';

// Phase 2 of the evaluator-integrity track: the SymbolGraph is built only when
// an active rule declares `usesTypeModel` (its one consumer is the TypeModel),
// once per run, shared; a rule that reads the TypeModel without declaring it
// fails loudly instead of silently building a second graph.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');
const solidFixtures = join(here, 'fixtures', 'solid');
const declared = join(solidFixtures, 'dip-declared');

before(async () => {
    await initDart();
});

const architecture = (): ArchitectureModel => new ArchitectureModel(loadArchitectureConfig(join(declared, 'stoa.architecture.json')), join(declared, 'project'));

/** Every rule the pipeline can register (plus the unregistered SRP rule), each in every variant. */
const everyRule = (): ProjectRule[] => [
    new DependencyCycleRule(),
    ...flutterLayoutRules(),
    ...flutterLifecycleRules(),
    new DeadExportRule(),
    ...solidRules(),
    ...solidRules(architecture()),
    new SolidSrpResponsibilityCohesionRule()
];

/** The pipeline's input for one rule: a module graph always, the symbol graph only when the rule set needs it. */
const pipelineInput = (facts: Fact[], rules: readonly ProjectRule[]): ProjectRuleInput => {
    const analyzedFiles = new Set(facts.map((fact) => fact.subject.file));
    const moduleGraph = buildModuleGraph(facts, analyzedFiles, new ModuleResolver(EMPTY_PROJECT_CONFIG), flutterAwareIndex(facts));
    return {
        facts,
        analyzedFiles,
        moduleGraph,
        ...(needsSymbolGraph(rules) ? {symbolGraph: buildSymbolGraph(facts, moduleGraph)} : {}),
        ruleSetId: 'default',
        knowledgeBase: KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase),
        lang: 'en'
    };
};

const solidFacts = (): Fact[] => analyze({rootPath: solidFixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, solid: true}).facts;

test('demand: only the TypeModel readers (LSP, ISP, DIP-concrete, SRP) declare usesTypeModel, only R-UNUSED-EXPORT usesSymbolGraph; without --solid and --dead-exports no rule needs the SymbolGraph', () => {
    assert.deepEqual(
        everyRule()
            .filter((rule) => rule.usesTypeModel === true)
            .map((rule) => rule.id)
            .sort(),
        [
            'R-SOLID-DIP-CONCRETE-DEPENDENCY',
            'R-SOLID-DIP-CONCRETE-DEPENDENCY',
            'R-SOLID-ISP-INTERFACE-COHESION',
            'R-SOLID-ISP-INTERFACE-COHESION',
            'R-SOLID-LSP-CONTRACT-COMPATIBILITY',
            'R-SOLID-LSP-CONTRACT-COMPATIBILITY',
            'R-SOLID-SRP-RESPONSIBILITY-COHESION'
        ]
    );
    assert.deepEqual(
        everyRule()
            .filter((rule) => rule.usesSymbolGraph === true)
            .map((rule) => rule.id),
        ['R-UNUSED-EXPORT']
    );
    // The pipeline's rule sets without --solid and --dead-exports, with --dead-exports, and with --solid.
    assert.equal(needsSymbolGraph([new DependencyCycleRule(), ...flutterLayoutRules(), ...flutterLifecycleRules()]), false);
    assert.equal(needsSymbolGraph([new DependencyCycleRule(), new DeadExportRule()]), true);
    assert.equal(needsSymbolGraph([new DependencyCycleRule(), ...solidRules()]), true);
    assert.equal(needsSymbolGraph([new DependencyCycleRule(), ...solidRules(architecture())]), true);
    assert.equal(needsSymbolGraph([]), false);
});

test('declarations are truthful: every rule runs on the pipeline input without a symbol graph unless it declares usesTypeModel or usesSymbolGraph — none reads either undeclared', () => {
    const facts = solidFacts();
    for (const rule of everyRule()) {
        assert.doesNotThrow(() => rule.evaluate(pipelineInput(facts, [rule])), rule.id);
    }
});

test('a rule that reads the TypeModel without declaring it fails loudly (no silent second SymbolGraph)', () => {
    const facts = solidFacts();
    const inner = new SolidLspContractCompatibilityRule();
    const undeclared: ProjectRule = {id: inner.id, version: inner.version, evaluate: (input) => inner.evaluate(input)};
    assert.throws(() => undeclared.evaluate(pipelineInput(facts, [undeclared])), /does not declare `usesTypeModel`/);
});

test('a rule that reads the SymbolGraph without declaring it fails loudly (no silent second SymbolGraph)', () => {
    const facts = solidFacts();
    const inner = new DeadExportRule();
    const undeclared: ProjectRule = {id: inner.id, version: inner.version, evaluate: (input) => inner.evaluate(input)};
    assert.throws(() => undeclared.evaluate(pipelineInput(facts, [undeclared])), /does not declare `usesSymbolGraph`/);
});

test('the shared SymbolGraph changes no finding: TypeModel rules on the pipeline input equal the direct (self-built) path, also under reversed fact order', () => {
    const facts = solidFacts();
    const rules = [new SolidLspContractCompatibilityRule(), ...solidRules().slice(2), new SolidSrpResponsibilityCohesionRule()];
    const knowledgeBase = KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase);
    const ids = (input: ProjectRuleInput): string[] => rules.flatMap((rule) => rule.evaluate(input).map((finding) => `${finding.rule.id} ${finding.location.symbol ?? ''}`)).sort();
    const shared = ids(pipelineInput(facts, rules));
    assert.ok(shared.length > 0, 'the fixture produces TypeModel findings');
    const direct = ids({facts, analyzedFiles: new Set(facts.map((fact) => fact.subject.file)), ruleSetId: 'default', knowledgeBase, lang: 'en'});
    assert.deepEqual(shared, direct);
    const reversed = [...facts].reverse();
    assert.deepEqual(ids(pipelineInput(reversed, rules)), shared);
});
