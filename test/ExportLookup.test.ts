import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Project} from 'ts-morph';
import type {SourceFile} from 'ts-morph';
import {exportLookup} from '../src/analysis/typescript/ExportLookup.js';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';

// The export lookup (keyword shortcut, ts-morph otherwise) must answer exactly
// like ts-morph's symbol-based isExported()/isDefaultExport() — checked
// declaration by declaration against ts-morph itself (a full Project with lib
// files), incl. a `.d.ts` module whose declarations are exported implicitly.

const CASES: ReadonlyArray<[string, string]> = [
    ['list.ts', 'function a() {}\nclass B {}\ninterface I {}\ntype T = 1;\nenum E { X }\nconst v = 1, {w} = {w: 2};\nfunction hidden() {}\nexport {a, B as Bee, v, w};\nexport type {I, T};\nexport {E as "e e"};\n'],
    ['named-default.ts', 'function a() {}\nclass B {}\nexport {B as default, a};\n'],
    ['default-id.ts', 'function a() {}\nclass B {}\nexport default a;\n'],
    ['default-class.ts', 'function a() {}\nclass B {}\nexport default B;\nexport {a};\n'],
    ['default-call.ts', 'function a() { return 1; }\nexport default a();\n'],
    ['default-paren.ts', 'function a() {}\nexport default (a);\n'],
    ['default-member.ts', 'namespace N { export const x = 1; }\nfunction a() {}\nexport default N.x;\n'],
    ['default-interface.ts', 'interface I {}\nfunction a() {}\nexport default I;\n'],
    ['equals.ts', 'function make() {}\nclass Other {}\nexport = make;\n'],
    ['equals-expr.ts', 'function make() { return 1; }\nexport = make();\n'],
    ['reexport.ts', 'function a() {}\nclass B {}\nexport {a} from "./x";\nexport {B as default} from "./y";\nexport * from "./z";\nexport * as ns from "./w";\nexport {B};\n'],
    ['keyword-mix.ts', 'export function k() {}\nfunction a() {}\nexport default class Main {}\nexport {a};\n'],
    ['overloads.ts', 'function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown): void {}\nexport {f};\n'],
    ['enum-namespace.ts', 'enum E { X }\nnamespace E { export const y = 1; }\nfunction g() {}\nexport {E, g};\n'],
    ['two-defaults.ts', 'function a() {}\nfunction b() {}\nexport default a;\nexport {b as default};\n'],
    ['import-shadow.ts', 'import {a} from "./m";\nfunction b() {}\nexport {a, b};\n'],
    ['declare-global.ts', 'function a() {}\nexport {a};\ndeclare global { interface Window { x: number } }\n'],
    ['implicit.d.ts', 'export function a(): void;\nfunction b(): void;\ndeclare class C {}\ninterface I {}\n'],
    ['listed.d.ts', 'function a(): void;\ndeclare class C {}\nexport {a};\n'],
    ['plain.js', 'function a() {}\nclass B {}\nexport {a};\nexport default B;\n'],
    ['typedef.js', '/** @typedef {{x: number}} Shape */\nfunction a() {}\nexport {a};\n'],
    ['no-exports.ts', 'import {x} from "./x";\nfunction a() { return x; }\nexport function b() {}\n']
];

const declarationsOf = (sourceFile: SourceFile) => [
    ...sourceFile.getFunctions(),
    ...sourceFile.getClasses(),
    ...sourceFile.getInterfaces(),
    ...sourceFile.getTypeAliases(),
    ...sourceFile.getEnums(),
    ...sourceFile.getVariableStatements()
];

for (const [name, content] of CASES) {
    test(`export lookup equals ts-morph: ${name}`, () => {
        const project = new Project({useInMemoryFileSystem: true, compilerOptions: {allowJs: true}});
        const sourceFile = project.createSourceFile(`/${name}`, content);
        const lookup = exportLookup(sourceFile);
        for (const declaration of declarationsOf(sourceFile)) {
            const label = `${name}: ${declaration.getKindName()} ${declaration.getText().split('\n')[0] ?? ''}`;
            assert.equal(lookup.isExported(declaration), declaration.isExported(), `isExported — ${label}`);
        }
        for (const declaration of [...sourceFile.getFunctions(), ...sourceFile.getClasses()]) {
            const label = `${name}: ${declaration.getKindName()} ${declaration.getName() ?? '(anonymous)'}`;
            assert.equal(lookup.isDefaultExport(declaration), declaration.isDefaultExport(), `isDefaultExport — ${label}`);
        }
    });
}

test('a .d.ts module without an export list: every declaration is an export fact (as before the keyword shortcut)', () => {
    const adapter = new TypeScriptAdapter();
    const content = 'export function a(): void;\nfunction b(): void;\ndeclare class C {}\ninterface I {}\n';
    const facts = adapter.extractFacts(adapter.parse({path: '/types/x.d.ts', content}), {rootDir: '/'});
    assert.deepEqual(
        facts.filter((fact) => fact.kind === 'deps.export').map((fact) => fact.value),
        ['a', 'b', 'C', 'I']
    );
    assert.equal(facts.find((fact) => fact.kind === 'metric.exportCount')?.value, 4);
});
