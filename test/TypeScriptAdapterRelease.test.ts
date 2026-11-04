import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {SourceFile} from 'ts-morph';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';

// An ES module is parsed in a Project of its own without lib files (released
// by dropping it); a script — whose top-level names merge with lib globals —
// and a file with `declare global` keep the shared Project with the lib files.

const adapter = new TypeScriptAdapter();

const projectFilesOf = (path: string, content: string): {count: number; hasLib: boolean; release: () => void} => {
    const parsed = adapter.parse({path, content});
    const sourceFile = parsed.handle as SourceFile;
    const files = sourceFile.getProject().getSourceFiles();
    const hasLib = sourceFile.getProject().getProgram().compilerObject.getSourceFiles().some((file) => /\/lib\.[^/]*\.d\.ts$/.test(file.fileName));
    return {count: files.length, hasLib, release: () => parsed.release?.()};
};

test('an ES module gets its own Project without lib files', () => {
    const module = projectFilesOf('/m.ts', 'export const a = 1;\n');
    assert.equal(module.count, 1);
    assert.equal(module.hasLib, false);
    module.release();
});

test('a script and a file with declare global keep the shared Project with lib files, released after use', () => {
    const script = projectFilesOf('/s.js', 'var name = 1;\nfunction open() {}\n');
    assert.equal(script.hasLib, true);
    script.release();
    const augmenting = projectFilesOf('/g.ts', 'export {};\ndeclare global { interface Window { x: number } }\n');
    assert.equal(augmenting.hasLib, true);
    augmenting.release();
});

test('module facts do not depend on the path taken: the same declarations, symbols and metrics', () => {
    const content = 'export function f(a: boolean): number {\n    return a ? 1 : 2;\n}\n';
    const viaModule = adapter.extractFacts(adapter.parse({path: '/x.ts', content}), {rootDir: '/'});
    const viaScript = adapter.extractFacts(adapter.parse({path: '/y.ts', content: content.replace('export ', '')}), {rootDir: '/'});
    const metrics = (facts: typeof viaModule): unknown[] => facts.filter((fact) => fact.kind.startsWith('metric.') && fact.kind !== 'metric.exportCount').map((fact) => [fact.kind, fact.subject.symbol, fact.value]);
    assert.deepEqual(metrics(viaModule), metrics(viaScript));
});
