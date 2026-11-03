import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import type {StateLifecycleValue} from '../src/analysis/dart/FlutterLifecycle.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {KnowledgeBase} from '../src/knowledge/KnowledgeBase.js';
import {analyze} from '../src/Pipeline.js';
import {flutterLifecycleRules} from '../src/rules/project/FlutterLifecycleRules.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'flutter-lifecycle');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

before(async () => {
    await initDart();
});

const RULE_IDS = new Set(flutterLifecycleRules().map((rule) => rule.id));

const lifecycleFindings = (path: string, lang = 'en'): Finding[] =>
    analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, lang}).report.findings.filter((finding) => RULE_IDS.has(finding.rule.id));

const brief = (findings: readonly Finding[]): string[] => findings.map((finding) => `${finding.rule.id} ${finding.location.range.startLine} ${String(finding.observation.evidence[0]?.value)}`);

test('positive fixture: each lifecycle defect is reported once, at the creation / call site', () => {
    assert.deepEqual(brief(lifecycleFindings(join(fixtures, 'Positive.dart'))), [
        'R-FLUTTER-UNDISPOSED-CONTROLLER 11 _BrokenState._text = TextEditingController; dispose: no mention',
        'R-FLUTTER-UNDISPOSED-CONTROLLER 21 _BrokenState._anim = AnimationController; dispose: no mention',
        'R-FLUTTER-UNCANCELLED-SUBSCRIPTION 22 _BrokenState._timer = Timer.periodic; dispose: no mention',
        'R-FLUTTER-INHERITED-IN-INITSTATE 24 _BrokenState.initState: Theme.of(context)',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 30 _BrokenState.load: await (line 29) → setState (line 30), no mounted',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 43 _BrokenState.build: await (line 42) → setState (line 43), no mounted',
        'R-FLUTTER-UNCANCELLED-SUBSCRIPTION 56 _SubState._events = source.listen; dispose: absent',
        'R-FLUTTER-INHERITED-IN-INITSTATE 57 _SubState.initState: MediaQuery.sizeOf(context)'
    ]);
});

test('negative fixture: released (also via helper / loop), unclear ownership, mounted-guarded, pre-await, non-inherited lookups stay silent', () => {
    assert.deepEqual(brief(lifecycleFindings(join(fixtures, 'Negative.dart'))), []);
});

test('skipped: unknown project mixin, custom base State, and a local State class (not Flutter) produce nothing', () => {
    assert.deepEqual(brief(lifecycleFindings(join(fixtures, 'Skipped.dart'))), []);
    assert.deepEqual(brief(lifecycleFindings(join(fixtures, 'Shadowed.dart'))), []);
});

test('fact: dart.stateLifecycle is neutral, plain data (creations, dispose mentions, context calls, setState order)', () => {
    const facts = analyze({rootPath: join(fixtures, 'Negative.dart'), knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG}).facts.filter((fact) => fact.kind === 'dart.stateLifecycle');
    assert.equal(facts.length, 1);
    const value = facts[0]?.value as unknown as StateLifecycleValue;
    assert.equal(value.className, '_FineState');
    assert.deepEqual(
        value.creations.map((creation) => `${creation.field}@${creation.method ?? 'field'}=${creation.names.join('.')}`),
        ['_a@field=TextEditingController', '_b@field=FocusNode', '_c@field=ScrollController', '_timer@initState=Timer']
    );
    assert.deepEqual(value.disposeMentions, ['_a', '_b', '_c', '_timer']);
    assert.deepEqual(
        value.initStateContextCalls.map((call) => call.names.join('.')),
        ['Navigator.of']
    );
    assert.deepEqual(
        value.setStateCalls.map((call) => `${call.method}:${call.afterAwait}/${call.mountedBetween}`),
        ['load:false/false', 'load:true/true', 'other:true/true', 'sync:false/false']
    );
    assert.equal(JSON.stringify(value).includes('"type"'), false, 'no AST node leaks into the fact');
});

test('finding shape: robustness, principle per rule, evidence is a produced fact kind, localized', () => {
    const result = analyze({rootPath: join(fixtures, 'Positive.dart'), knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const factKinds = new Set(result.facts.map((fact) => fact.kind));
    const findings = result.report.findings.filter((finding) => RULE_IDS.has(finding.rule.id));
    for (const finding of findings) {
        assert.deepEqual(finding.interpretation.dimensions, ['robustness']);
        assert.ok(finding.observation.evidence.every((evidence) => factKinds.has(evidence.fact)));
        assert.equal(finding.interpretation.principles[0]?.id, finding.rule.id === 'R-FLUTTER-INHERITED-IN-INITSTATE' ? 'marcus.judgment' : 'marcus.control');
    }
    const german = lifecycleFindings(join(fixtures, 'Positive.dart'), 'de').find((finding) => finding.rule.id === 'R-FLUTTER-INHERITED-IN-INITSTATE');
    assert.equal(german?.observation.statement, '_BrokenState.initState() ruft Theme.of(context) auf.');
    assert.equal(german?.severity, 'high');
});

test('requiredFactKinds is truthful: evaluating on only those kinds yields identical findings', () => {
    const result = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    const knowledgeBase = KnowledgeBase.loadFromDirectory(knowledgeDir, DEFAULT_CONFIG.knowledgeBase);
    const analyzedFiles = new Set(result.facts.map((fact) => fact.subject.file));
    for (const rule of flutterLifecycleRules()) {
        const kinds = new Set(rule.requiredFactKinds);
        const input = {analyzedFiles, ruleSetId: 'default@1', knowledgeBase, lang: 'en'};
        const full = rule.evaluate({...input, facts: result.facts});
        assert.deepEqual(rule.evaluate({...input, facts: result.facts.filter((fact) => kinds.has(fact.kind))}), full, rule.id);
        assert.ok(full.length > 0, `${rule.id} fires on the fixtures`);
    }
});

test('FactCache: a cache hit (no re-parse) yields identical lifecycle findings', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stoa-lifecycle-cache-'));
    try {
        const pick = (findings: readonly Finding[]): string => JSON.stringify(findings.filter((finding) => RULE_IDS.has(finding.rule.id)));
        const cold = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        const warm = analyze({rootPath: fixtures, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, cacheDir});
        assert.ok((warm.report.coverage.cacheHits ?? 0) > 0, 'second run is served from the cache');
        assert.equal(pick(warm.report.findings), pick(cold.report.findings));
    } finally {
        rmSync(cacheDir, {recursive: true, force: true});
    }
});

// Flutter quality track, Phase C (rules 1.2.0): mounted guards, subscriptions, resource ownership.
const phaseC = join(here, 'fixtures', 'flutter-lifecycle-phase-c');

const stateFacts = (path: string): StateLifecycleValue[] =>
    analyze({rootPath: path, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG})
        .facts.filter((fact) => fact.kind === 'dart.stateLifecycle')
        .map((fact) => fact.value as unknown as StateLifecycleValue);

test('mounted: dominating guards are recognised; a mention that does not guard, a guard before the await or a break is reported', () => {
    assert.deepEqual(brief(lifecycleFindings(join(phaseC, 'Guards.dart'))), [
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 54 _GuardsState.onlyMentioned: await (line 50) → setState (line 54), mounted (line 51) does not guard it',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 62 _GuardsState.noExit: await (line 58) → setState (line 62), mounted (line 59) does not guard it',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 70 _GuardsState.siblingBranch: await (line 66) → setState (line 70), mounted (line 68) does not guard it',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 76 _GuardsState.guardBeforeAwait: await (line 75) → setState (line 76), no mounted',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT 86 _GuardsState.breakInExit: await (line 81) → setState (line 86), mounted (line 82) does not guard it'
    ]);
});

test('mounted: guard classification per setState (dominating / non-dominating / unknown / none), exclusive branches are not "after" the await', () => {
    const [guards] = stateFacts(join(phaseC, 'Guards.dart'));
    assert.deepEqual(
        guards?.setStateCalls.map((call) => `${call.method} ${call.afterAwait ? call.guard : 'not-after-await'}`),
        [
            'earlyReturn dominating',
            'blockExitContext dominating',
            'insideIf dominating',
            'elseOfNegated dominating',
            'ternary dominating',
            'onlyMentioned non-dominating',
            'noExit non-dominating',
            'siblingBranch non-dominating',
            'guardBeforeAwait none',
            'breakInExit non-dominating',
            'aliased unknown',
            'compared unknown',
            'exclusive not-after-await'
        ]
    );
});

test('resources: a typed StreamSubscription and an owned controller are reported; own listen(), untyped listen, cancel(), dispose() and external ownership are not', () => {
    assert.deepEqual(brief(lifecycleFindings(join(phaseC, 'Resources.dart'))), [
        'R-FLUTTER-UNCANCELLED-SUBSCRIPTION 31 _ResourcesState._typed = widget.stream.listen; dispose: no mention',
        'R-FLUTTER-UNDISPOSED-CONTROLLER 35 _ResourcesState._owned = TextEditingController; dispose: no mention'
    ]);
});

test('resources: fact v2 records declared field types, external ownership and certain release calls', () => {
    const [resources] = stateFacts(join(phaseC, 'Resources.dart'));
    assert.equal(resources?.v, 2);
    const typeOf = (field: string): string | null => {
        const type = resources?.fieldTypes[resources.fields.indexOf(field)] ?? null;
        return type === null ? null : type[1];
    };
    assert.equal(typeOf('_typed'), 'StreamSubscription');
    assert.equal(typeOf('_untyped'), null);
    assert.equal(typeOf('_handle'), 'int');
    assert.deepEqual(resources?.externalFields, ['_external', '_handle']);
    // `?.cancel()`, `.dispose()`, `this.x.dispose()`, `?..cancel()`; `_timer = null` is not an external assignment.
    assert.deepEqual(resources?.releaseCalls, ['_cancelled', '_focus', '_scroll', '_timer']);
});

test('Phase C versions: controller, subscription and setState rules at 1.2.0, inherited-in-initState at 1.1.0', () => {
    const findings = [...lifecycleFindings(join(fixtures, 'Positive.dart')), ...lifecycleFindings(join(phaseC, 'Resources.dart'))];
    const versions = [...new Set(findings.map((finding) => `${finding.rule.id}@${finding.rule.version}`))].sort();
    assert.deepEqual(versions, [
        'R-FLUTTER-INHERITED-IN-INITSTATE@1.1.0',
        'R-FLUTTER-SETSTATE-AFTER-AWAIT@1.2.0',
        'R-FLUTTER-UNCANCELLED-SUBSCRIPTION@1.2.0',
        'R-FLUTTER-UNDISPOSED-CONTROLLER@1.2.0'
    ]);
});
