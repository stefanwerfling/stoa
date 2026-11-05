import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, relative} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {initHtml} from '../src/analysis/HtmlAdapter.js';
import {HtmlAdapter} from '../src/analysis/HtmlAdapter.js';
import {assignSiteSymbols, DOCUMENT_SCOPE} from '../src/analysis/SiteIdentity.js';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';
import {migrateBaseline} from '../src/BaselineMigration.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {findingKey, IDENTITY_KINDS, IDENTITY_SCHEME, keyString, type IdentityScheme} from '../src/FindingIdentity.js';
import {analyze} from '../src/Pipeline.js';
import {toMarkdown} from '../src/reporting/Reporter.js';
import type {Fact, Finding} from '../src/Types.js';

// Finding identity scheme 3 (src/FindingIdentity.ts) and the identity kinds:
// the cases the quality-hardening spec (phase 2) names — a site inserted
// before another, a moved method, a moved module, a new method, same names in
// different classes, overloads and preprocessor twins, anonymous functions,
// static HTML and templates, imports and re-exports, a different fact order —
// plus where each identity is anchored (`location.identityKind`). Namespaces
// and C++ overloads by parameter types are covered in IdentityScheme.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let work: string;

before(async () => {
    await initCpp();
    await initHtml();
    work = mkdtempSync(join(tmpdir(), 'stoa-identity-stability-'));
});

after(() => {
    rmSync(work, {recursive: true, force: true});
});

const project = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(work, 'case-'));
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), {recursive: true});
        writeFileSync(join(dir, name), content);
    }
    return dir;
};

const run = (dir: string, options: {scheme?: IdentityScheme; typecheck?: boolean} = {}): ReturnType<typeof analyze> =>
    analyze({
        rootPath: dir,
        knowledgeDir,
        ruleSetDir,
        config: DEFAULT_CONFIG,
        ...(options.scheme !== undefined ? {identityScheme: options.scheme} : {}),
        ...(options.typecheck === true ? {typecheck: true} : {})
    });

/** `rule symbol [kind]` of every finding of `rule` (all rules when absent), in report order. */
const findingsOf = (dir: string, rule?: string, options: {scheme?: IdentityScheme; typecheck?: boolean} = {}): string[] =>
    run(dir, options)
        .report.findings.filter((finding) => rule === undefined || finding.rule.id === rule)
        .map((finding) => `${relative(dir, finding.location.file)} ${finding.location.symbol ?? ''} [${finding.location.identityKind ?? '-'}]`);

const symbolsOf = (dir: string, rule: string): string[] =>
    run(dir)
        .report.findings.filter((finding) => finding.rule.id === rule)
        .map((finding) => finding.location.symbol ?? '');

/** `symbol [kind]` of one fact kind, in source order. */
const factsOf = (facts: readonly Fact[], kind: string): string[] =>
    facts
        .filter((fact) => fact.kind === kind)
        .sort((a, b) => a.subject.range.startLine - b.subject.range.startLine || a.subject.range.startCol - b.subject.range.startCol)
        .map((fact) => `${fact.subject.symbol ?? ''} [${fact.subject.identityKind ?? '-'}]`);

const swallow = (name: string): string => `export function ${name}(): void { try { JSON.parse('x'); } catch { } }`;

test('scheme 3 is the running scheme; every kind is named once', () => {
    assert.equal(IDENTITY_SCHEME, 3);
    assert.deepEqual([...new Set(IDENTITY_KINDS)], ['declaration', 'anonymous', 'site', 'module', 'external', 'fileOrdinal', 'ambiguous', 'file']);
});

test('a site inserted before another in the SAME declaration shifts it; in another declaration or at top level it does not', () => {
    const dir = project({'a.ts': `${swallow('load')}\n`});
    assert.deepEqual(symbolsOf(dir, 'R-ERR-SWALLOWED'), ['load>catch#0']);
    // A new catch in a new function above: the old site keeps its name.
    writeFileSync(join(dir, 'a.ts'), `${swallow('early')}\n${swallow('load')}\n`);
    assert.deepEqual(symbolsOf(dir, 'R-ERR-SWALLOWED'), ['early>catch#0', 'load>catch#0']);
    // A new catch at top level: counted among the file-level sites, renames nothing inside a declaration.
    writeFileSync(join(dir, 'a.ts'), `try { JSON.parse('y'); } catch { }\n${swallow('early')}\n${swallow('load')}\n`);
    assert.deepEqual(symbolsOf(dir, 'R-ERR-SWALLOWED'), ['(module)>catch#0', 'early>catch#0', 'load>catch#0']);
    // Two catches in one function are numbered within it, in source order — the documented limit.
    writeFileSync(join(dir, 'a.ts'), "export function load(): void { try { JSON.parse('n'); } catch { } try { JSON.parse('x'); } catch { } }\n");
    assert.deepEqual(symbolsOf(dir, 'R-ERR-SWALLOWED'), ['load>catch#0', 'load>catch#1']);
});

test('a top-level site counts only the file-level sites: a catch added inside a function no longer shifts it (scheme 2 did)', () => {
    const before = "try { JSON.parse('a'); } catch { }\n";
    const dir = project({'a.ts': before});
    assert.deepEqual(findingsOf(dir, 'R-ERR-SWALLOWED'), ['a.ts (module)>catch#0 [fileOrdinal]']);
    writeFileSync(join(dir, 'a.ts'), `${swallow('first')}\n${before}`);
    assert.deepEqual(findingsOf(dir, 'R-ERR-SWALLOWED'), ['a.ts first>catch#0 [site]', 'a.ts (module)>catch#0 [fileOrdinal]']);
    // Scheme 2 left it at its per-file ordinal, shifted by the catch above.
    assert.deepEqual(findingsOf(dir, 'R-ERR-SWALLOWED', {scheme: 2}), ['a.ts first>catch#0 [site]', 'a.ts catch#1 [fileOrdinal]']);
});

test('a site in a top-level binding is anchored to the binding: const, export default, module.exports', () => {
    const dir = project({
        'orm.ts': 'export const dataSource = {\n    synchronize: true\n};\n',
        'def.ts': 'export default {\n    synchronize: true\n};\n',
        'cjs.js': 'module.exports = {\n    synchronize: true\n};\n'
    });
    assert.deepEqual(findingsOf(dir, 'R-ORM-SYNCHRONIZE-ENABLED').sort(), ['cjs.js module.exports>synchronize#0 [site]', 'def.ts default>synchronize#0 [site]', 'orm.ts dataSource>synchronize#0 [site]']);
    // A binding added above renames nothing; a destructuring pattern is no anchor.
    writeFileSync(join(dir, 'orm.ts'), 'export const other = {\n    synchronize: true\n};\nexport const dataSource = {\n    synchronize: true\n};\n');
    assert.deepEqual(symbolsOf(dir, 'R-ORM-SYNCHRONIZE-ENABLED').filter((symbol) => !symbol.startsWith('default') && !symbol.startsWith('module')), ['other>synchronize#0', 'dataSource>synchronize#0']);
});

test('moving a method inside its class, and adding a new method, renames no identity', () => {
    const cls = (methods: string[]): string => `export class Service {\n${methods.join('\n')}\n}\n`;
    const load = "    load(): void { try { JSON.parse('a'); } catch { } }";
    const save = "    save(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }";
    const added = "    added(): void { try { JSON.parse('c'); } catch { } }";
    const dir = project({'s.ts': cls([load, save])});
    const first = findingsOf(dir);
    writeFileSync(join(dir, 's.ts'), cls([save, load]));
    assert.deepEqual(findingsOf(dir).sort(), [...first].sort(), 'methods swapped');
    writeFileSync(join(dir, 's.ts'), cls([added, save, load]));
    const grown = findingsOf(dir);
    assert.deepEqual(grown.filter((line) => !line.includes('Service.added')).sort(), [...first].sort(), 'new method above');
    assert.ok(grown.includes('s.ts Service.added>catch#0 [site]'), grown.join('\n'));
    assert.ok(first.includes('s.ts Service.load>catch#0 [site]') && first.includes('s.ts Service.save [declaration]'), first.join('\n'));
});

test('moving a module changes the file part of the identity only; the symbol stays', () => {
    const dir = project({'src/old/service.ts': `${swallow('load')}\n`});
    const before = run(dir).report.findings.map((finding) => findingKey(dir, finding));
    mkdirSync(join(dir, 'src', 'new'), {recursive: true});
    renameSync(join(dir, 'src', 'old', 'service.ts'), join(dir, 'src', 'new', 'service.ts'));
    const moved = run(dir).report.findings.map((finding) => findingKey(dir, finding));
    assert.deepEqual(moved.map((key) => [key.rule, key.symbol]), before.map((key) => [key.rule, key.symbol]));
    assert.deepEqual(moved.map((key) => key.file), before.map(() => 'src/new/service.ts'));
});

test('same-named methods in two classes of one file are two identities', () => {
    const dir = project({'two.ts': "export class A { load(): void { try { JSON.parse('a'); } catch { } } }\nexport class B { load(): void { try { JSON.parse('b'); } catch { } } }\n"});
    assert.deepEqual(symbolsOf(dir, 'R-ERR-SWALLOWED'), ['A.load>catch#0', 'B.load>catch#0']);
});

test('C++: definitions sharing name and parameters are told apart by their preprocessor condition; identical conditions stay ambiguous', () => {
    const twins = '#ifndef HAVE_CUDA\nint load(int a) { return a; }\n#else\nint load(int a) { return a + 1; }\n#endif\n';
    const nested = '#if defined(A) && B > 1\n#ifdef C\nint g(int a) { return a; }\n#endif\n#endif\nint g(int a) { return 0; }\n';
    const same = '#ifdef X\nint f(int a) { return a; }\n#endif\n#ifdef X\nint f(int a) { return a; }\n#endif\n';
    const guard = '#ifndef H_H\n#define H_H\nint h(int a) { return a; }\nint h(double a) { return 0; }\n#endif\n';
    const dir = project({'twins.cpp': twins, 'nested.cpp': nested, 'same.cpp': same, 'guard.h': guard});
    const facts = run(dir).facts;
    const of = (name: string): string[] => factsOf(facts.filter((fact) => basename(fact.subject.file) === name), 'metric.cyclomaticComplexity');
    assert.deepEqual(of('twins.cpp'), ['load(int)[!HAVE_CUDA] [declaration]', 'load(int)[HAVE_CUDA] [declaration]']);
    assert.deepEqual(of('nested.cpp'), ['g(int)[defined(A) && B > 1 && C] [declaration]', 'g(int) [declaration]']);
    assert.deepEqual(of('same.cpp'), ['f(int)[X]#0 [ambiguous]', 'f(int)[X]#1 [ambiguous]']);
    // The include guard is no condition; parameter types tell these apart already.
    assert.deepEqual(of('guard.h'), ['h(int) [declaration]', 'h(double) [declaration]']);
    // Scheme 2 numbered the twins by order.
    const legacy = run(dir, {scheme: 2}).facts.filter((fact) => basename(fact.subject.file) === 'twins.cpp');
    assert.deepEqual(factsOf(legacy, 'metric.cyclomaticComplexity'), ['load(int)#0 [ambiguous]', 'load(int)#1 [ambiguous]']);
});

test('anonymous functions are numbered within their scope and are of kind anonymous', () => {
    const dir = project({'cb.ts': 'export function outer(): void {\n    [1].map(() => { try { JSON.parse("a"); } catch { } });\n    [2].map(() => { try { JSON.parse("b"); } catch { } });\n}\n'});
    const facts = run(dir).facts;
    assert.deepEqual(factsOf(facts, 'metric.cyclomaticComplexity'), ['outer [declaration]', 'outer.(anonymous)#0 [anonymous]', 'outer.(anonymous)#1 [anonymous]']);
    assert.deepEqual(findingsOf(dir, 'R-ERR-SWALLOWED'), ['cb.ts outer.(anonymous)#0>catch#0 [site]', 'cb.ts outer.(anonymous)#1>catch#0 [site]']);
});

test('static HTML: a site is anchored to the nearest element with an id, else to the document; an element added elsewhere renames nothing', () => {
    const page = (extra: string): string =>
        `<!doctype html><html lang="en"><body>\n${extra}<form id="login"><input type="text"></form>\n<main id="content"><section><img src="a.png"></section></main>\n<img src="b.png">\n</body></html>\n`;
    const dir = project({'index.html': page('')});
    const first = [...findingsOf(dir, 'R-A11Y-IMG-ALT'), ...findingsOf(dir, 'R-A11Y-FORM-LABEL')];
    assert.deepEqual(first, ['index.html #content>img#0 [site]', 'index.html (document)>img#0 [fileOrdinal]', 'index.html #login>field#0 [site]']);
    // A flagged image added at the top of the page: the anchored sites keep their names.
    writeFileSync(join(dir, 'index.html'), page('<img src="new.png">\n'));
    const grown = [...findingsOf(dir, 'R-A11Y-IMG-ALT'), ...findingsOf(dir, 'R-A11Y-FORM-LABEL')];
    assert.deepEqual(grown, ['index.html (document)>img#0 [fileOrdinal]', 'index.html #content>img#0 [site]', 'index.html (document)>img#1 [fileOrdinal]', 'index.html #login>field#0 [site]']);
});

test('templates: a Vue template site outside every id is anchored to the document, a static id anchors, a bound :id does not', () => {
    const vue = '<template>\n  <div id="card"><img src="a.png"></div>\n  <div :id="dyn"><img src="b.png"></div>\n</template>\n';
    const dir = project({'Card.vue': vue});
    assert.deepEqual(findingsOf(dir, 'R-A11Y-IMG-ALT'), ['Card.vue #card>img#0 [site]', 'Card.vue (document)>img#0 [fileOrdinal]']);
});

test('imports and re-exports: an import is its module (kind module); a re-export or import added above renames none', () => {
    const dir = project({'a.ts': "import {x} from './x';\nexport const y = 1;\n", 'x.ts': 'export const x = 1;\n'});
    assert.deepEqual(findingsOf(dir, 'R-DEP-UNUSED'), ['a.ts import:./x [module]']);
    writeFileSync(join(dir, 'a.ts'), "export {v} from './v';\nimport {w} from './w';\nimport {x} from './x';\nexport const y = 1;\n");
    writeFileSync(join(dir, 'v.ts'), 'export const v = 1;\n');
    writeFileSync(join(dir, 'w.ts'), 'export const w = 1;\n');
    assert.deepEqual(findingsOf(dir, 'R-DEP-UNUSED'), ['a.ts import:./w [module]', 'a.ts import:./x [module]']);
});

test('the site pass is independent of the fact order, anchors included (scheme 3)', () => {
    const adapter = new TypeScriptAdapter();
    const content = ['export const cfg = { synchronize: true };', 'try { JSON.parse("a"); } catch { }', 'export function f(): void { try { JSON.parse("b"); } catch { } }', 'try { JSON.parse("c"); } catch { }', ''].join('\n');
    const parsed = adapter.parse({path: join(work, 'order.ts'), content});
    const legacy = adapter.extractFacts(parsed, {rootDir: work, identityScheme: 1});
    // Scheme 1 extraction has no anchors: take them from a scheme-3 extraction of the same file.
    const anchors = adapter.extractFacts(parsed, {rootDir: work}).filter((fact) => fact.kind === 'struct.anchor');
    parsed.release?.();
    const facts = [...legacy, ...anchors];
    const view = (out: Fact[]): string[] => out.map((fact) => `${fact.kind} ${fact.subject.range.startLine}:${fact.subject.range.startCol} ${fact.subject.symbol ?? ''} ${fact.subject.identityKind ?? ''}`).sort();
    const forward = view(assignSiteSymbols(facts, 3));
    assert.deepEqual(view(assignSiteSymbols([...facts].reverse(), 3)), forward);
    for (const expected of ['ast.emptyCatch 2:26 (module)>catch#0 fileOrdinal', 'ast.emptyCatch 3:54 f>catch#0 site', 'ast.emptyCatch 4:26 (module)>catch#1 fileOrdinal', 'orm.synchronizeEnabled 1:22 cfg>synchronize#0 site']) {
        assert.ok(forward.includes(expected), `${expected}\n${forward.join('\n')}`);
    }
});

test('markup: the site pass names a file-level site (document), not (module)', () => {
    const adapter = new HtmlAdapter();
    const parsed = adapter.parse({path: join(work, 'p.html'), content: '<html><body><img src="x.png"></body></html>\n'});
    const facts = adapter.extractFacts(parsed, {rootDir: work});
    parsed.release?.();
    assert.deepEqual(factsOf(facts, 'ui.imageMissingAlt'), [`${DOCUMENT_SCOPE}>img#0 [fileOrdinal]`]);
});

test('type-checker diagnostics are anchored to their declaration like a site and are of kind external (--typecheck)', () => {
    const dir = project({'t.ts': "export class S {\n    load(): number {\n        const n: number = 'x';\n        return n;\n    }\n}\nexport const top: number = 'y';\n"});
    assert.deepEqual(findingsOf(dir, 'R-TYPE-UNSOUND', {typecheck: true}), ['t.ts S.load>tsc#0 [external]', 't.ts top>tsc#0 [external]']);
    // Scheme 2 kept the per-file ordinal.
    assert.deepEqual(findingsOf(dir, 'R-TYPE-UNSOUND', {typecheck: true, scheme: 2}), ['t.ts tsc#0 [external]', 't.ts tsc#1 [external]']);
});

test('every finding carries its identity kind: declaration, site, module, file — across the golden corpus', () => {
    const corpus = join(here, 'corpus', 'project');
    const findings = run(corpus).report.findings;
    assert.ok(findings.length > 0);
    const missing = findings.filter((finding: Finding) => finding.location.identityKind === undefined).map((finding) => `${finding.rule.id} ${finding.location.symbol ?? ''}`);
    assert.deepEqual(missing, []);
    const kindOf = (rule: string): string[] => [...new Set(findings.filter((finding) => finding.rule.id === rule).map((finding) => finding.location.identityKind ?? ''))];
    assert.deepEqual(kindOf('R-WIDE-PUBLIC-SURFACE'), ['file']);
    assert.deepEqual(kindOf('R-DEP-CYCLE'), ['module']);
    assert.deepEqual(kindOf('R-DEP-UNUSED'), ['module']);
    assert.deepEqual(kindOf('R-ERR-SWALLOWED'), ['site']);
    assert.deepEqual(kindOf('R-COMPLEXITY-COGNITIVE'), ['declaration']);
    // The Markdown report counts them, in kind order.
    assert.match(toMarkdown(run(corpus).report), /^- Finding identities: \d+ declaration, \d+ site, \d+ module, \d+ file$/m);
});

test('the identity kind is metadata: it is not part of the identity (file, rule, symbol)', () => {
    const dir = project({'a.ts': `${swallow('load')}\n`});
    const [finding] = run(dir).report.findings.filter((entry) => entry.rule.id === 'R-ERR-SWALLOWED');
    assert.ok(finding !== undefined);
    assert.equal(keyString(findingKey(dir, finding)), 'a.ts::R-ERR-SWALLOWED::load>catch#0');
    assert.equal(keyString(findingKey(dir, {...finding, location: {...finding.location, identityKind: 'fileOrdinal'}})), 'a.ts::R-ERR-SWALLOWED::load>catch#0');
});

test('migrating a scheme-2 baseline to scheme 3 pairs each finding with itself: a file ordinal becomes its anchored name', () => {
    const dir = project({'orm.ts': 'export const dataSource = {\n    synchronize: true\n};\n', 'a.ts': `try { JSON.parse('t'); } catch { }\n${swallow('load')}\n`});
    const legacy = run(dir, {scheme: 2}).report;
    const current = run(dir).report;
    const old = {version: 1 as const, identity: 2 as const, findings: legacy.findings.map((finding) => findingKey(dir, finding))};
    assert.ok(old.findings.some((key) => key.symbol === 'synchronize#0') && old.findings.some((key) => key.symbol === 'catch#0'));
    const migration = migrateBaseline(old, legacy, current, dir);
    assert.ok(migration.baseline !== null);
    assert.equal(migration.baseline.identity, 3);
    assert.deepEqual(migration.entries.filter((item) => item.outcome !== 'matched'), []);
    const symbols = migration.baseline.findings.map((key) => key.symbol);
    assert.ok(symbols.includes('dataSource>synchronize#0') && symbols.includes('(module)>catch#0') && symbols.includes('load>catch#0'), symbols.join(', '));
    assert.deepEqual(migration.baseline.findings.map(keyString), current.findings.map((finding) => keyString(findingKey(dir, finding))).sort());
});
