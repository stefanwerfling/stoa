import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {loadDartPackages} from '../src/analysis/dart/DartPackages.js';
import {flutterAwareIndex} from '../src/analysis/dart/FlutterCatalog.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {buildTypeModel, type TypeModel, type TypeNode} from '../src/model/TypeModel.js';
import {analyze} from '../src/Pipeline.js';
import {typeModelOf, type ProjectRuleInput} from '../src/rules/ProjectRule.js';
import type {Fact} from '../src/Types.js';

// Flutter quality track E4: the TypeModel — supertype resolution and inherited members.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'typemodel');
const knowledgeDir = join(root, 'knowledge', 'marcus');

let facts: Fact[] = [];
let model: TypeModel;

const build = (input: readonly Fact[]): TypeModel => {
    const files = new Set(input.map((fact) => fact.subject.file));
    const dartFiles = [...files].filter((file) => file.endsWith('.dart')).sort();
    return buildTypeModel(input, files, flutterAwareIndex(input, loadDartPackages(dartFiles)));
};

before(async () => {
    await initDart();
    facts = analyze({rootPath: project, knowledgeDir, ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG}).facts;
    model = build(facts);
});

const local = (key: string | null): string | null => (key === null ? null : key.slice(project.length + 1));
const node = (file: string, name: string): TypeNode => {
    const found = model.typeAt(join(project, file), name);
    assert.ok(found !== undefined, `${file} ${name}`);
    return found;
};
const supers = (file: string, name: string): string[] =>
    node(file, name).supertypes.map((supertype) => `${supertype.kind} ${supertype.prefix === null ? '' : `${supertype.prefix}.`}${supertype.name} → ${supertype.status} ${local(supertype.target) ?? supertype.origin ?? supertype.candidates.map((candidate) => candidate.replace(`file:${project}/`, '')).join(',')}`);
const inherited = (file: string, name: string): string[] =>
    node(file, name).inherited.map((entry) => `${entry.member.memberKind === 'setter' ? 'set ' : ''}${entry.member.name}@${(local(entry.from) ?? '').split('#')[1]}`);

test('E4 Dart: supertypes across files, through an export barrel and an import prefix; mixins; implements', () => {
    assert.deepEqual(supers('dart/lib/mid.dart', 'Mid'), [
        'extends bar.Base → project dart/lib/base.dart#Base',
        'with Mix → project dart/lib/mix.dart#Mix',
        'with Later → project dart/lib/mix.dart#Later'
    ]);
    assert.deepEqual(supers('dart/lib/edge.dart', 'Impl'), ['implements Base → project dart/lib/base.dart#Base']);
});

test('E4 Dart: ambiguous, unresolved (opaque package) and cyclic hierarchies are incomplete, never guessed', () => {
    assert.deepEqual(supers('dart/lib/edge.dart', 'Amb'), ['extends Dup → ambiguous dart/lib/x1.dart,dart/lib/x2.dart']);
    assert.deepEqual(supers('dart/lib/edge.dart', 'Ctrl'), ['extends GetxController → unresolved package:get/get.dart']);
    for (const name of ['Amb', 'Ctrl', 'CycleA', 'CycleB']) {
        assert.equal(node('dart/lib/edge.dart', name).hierarchyComplete, false, name);
        assert.deepEqual(node('dart/lib/edge.dart', name).inherited, [], name);
    }
});

test('E4: inherited members — most-derived first, last mixin wins, own members hide, no constructors/statics, implements does not inherit', () => {
    assert.deepEqual(inherited('dart/lib/mid.dart', 'Mid'), ['m@Later', 'b@Base', 'set b@Base']);
    assert.deepEqual(inherited('dart/lib/mid.dart', 'Leaf'), ['a@Mid', 'c@Mid', 'm@Later', 'b@Base', 'set b@Base']);
    assert.equal(node('dart/lib/mid.dart', 'Leaf').hierarchyComplete, true);
    assert.deepEqual(inherited('dart/lib/edge.dart', 'Impl'), []);
});

test('E4: a Flutter framework base contributes its catalogued members (State, StatefulWidget)', () => {
    const state = node('dart/lib/page.dart', '_PageState');
    assert.deepEqual(supers('dart/lib/page.dart', '_PageState'), ['extends State → external package:flutter/src/widgets/framework.dart']);
    assert.equal(state.hierarchyComplete, true);
    assert.deepEqual(state.frameworkMembers.map((member) => member.name).slice(0, 4), ['widget', 'context', 'mounted', 'setState']);
    assert.deepEqual(node('dart/lib/page.dart', 'Page').frameworkMembers.map((member) => member.name), ['key', 'createState', 'createElement']);
});

test('E4 TS: aliased named import, default import, namespace import, same-file declaration; package import external; globals and barrels unresolved', () => {
    assert.deepEqual(supers('ts/sub.ts', 'S1'), ['extends B → project ts/base.ts#Base']);
    assert.deepEqual(supers('ts/sub.ts', 'S2'), ['extends Def → project ts/def.ts#Def']);
    assert.deepEqual(supers('ts/sub.ts', 'S3'), ['extends ns.Base → project ts/base.ts#Base']);
    assert.deepEqual(supers('ts/sub.ts', 'S4'), ['extends Ext → external some-lib']);
    assert.deepEqual(supers('ts/sub.ts', 'S5'), ['extends Error → unresolved ']);
    assert.deepEqual(supers('ts/sub.ts', 'S6'), ['extends Local → project ts/sub.ts#Local']);
    assert.deepEqual(supers('ts/sub.ts', 'S7'), ['extends ViaBarrel → unresolved ']);
    assert.deepEqual(inherited('ts/sub.ts', 'S1'), ['b@Base']);
    assert.deepEqual(inherited('ts/sub.ts', 'S2'), ['x@Def']);
    assert.equal(node('ts/sub.ts', 'S4').hierarchyComplete, false);
});

test('E4: deterministic under reversed fact order', () => {
    const summary = (input: TypeModel): string => JSON.stringify(input.types.map((type) => ({...type, factId: type.factId})));
    assert.equal(summary(build([...facts].reverse())), summary(model));
});

test('E4: typeModelOf builds the model once per fact array and prefers the pipeline\'s', () => {
    const input: ProjectRuleInput = {
        facts,
        analyzedFiles: new Set(facts.map((fact) => fact.subject.file)),
        ruleSetId: 'default@test',
        knowledgeBase: KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase),
        lang: 'en'
    };
    const first = typeModelOf(input);
    assert.equal(typeModelOf({...input}), first, 'same fact array → same model');
    assert.equal(typeModelOf({...input, typeModel: model}), model);
    assert.ok(first.typeAt(join(project, 'ts/sub.ts'), 'S1') !== undefined);
});
