import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, sep} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import type {Finding} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'deadexports');

const deadExportFindings = (deadExports: boolean): Finding[] =>
    analyze({
        rootPath: project,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        deadExports
    }).report.findings.filter((f) => f.rule.id === 'R-UNUSED-EXPORT');

test('R-UNUSED-EXPORT is opt-in (off by default)', () => {
    assert.equal(deadExportFindings(false).length, 0);
});

test('R-UNUSED-EXPORT flags exports used nowhere, but not imported ones', () => {
    const findings = deadExportFindings(true);
    const names = findings.map((f) => f.location.symbol).sort();
    // `used` is imported by Consumer → not flagged; `dead` and `run` are unused.
    assert.deepEqual(names, ['dead', 'run']);
    assert.ok(!names.includes('used'));
    assert.equal(findings[0]?.interpretation.principles[0]?.id, 'marcus.cooperation');
});

test('dead-export analysis is deterministic', () => {
    assert.equal(JSON.stringify(deadExportFindings(true)), JSON.stringify(deadExportFindings(true)));
});

/** A throwaway project: `files` written below a fresh directory, analyzed with R-UNUSED-EXPORT on. */
const deadIn = (files: Record<string, string>, entryPoints?: string[]): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-dead-'));
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), {recursive: true});
        writeFileSync(join(dir, path), content);
    }
    const findings = analyze({
        rootPath: dir,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: {...DEFAULT_CONFIG, ...(entryPoints === undefined ? {} : {entryPoints})},
        deadExports: true
    }).report.findings.filter((f) => f.rule.id === 'R-UNUSED-EXPORT');
    return findings.map((f) => `${relative(dir, f.location.file).split(sep).join('/')}:${f.location.symbol}`).sort();
};

test('a re-export chain reaches the definition: every hop and the declaration count as used', () => {
    const files = {
        'types/retry.ts': 'export type RetryOptions = {limit: number};\nexport const unusedRetry = 1;\n',
        'types/options.ts': "export type {RetryOptions} from './retry';\nexport type Options = {retry: number};\n",
        'index.ts': "export type {RetryOptions} from './types/options';\n",
        'main.ts': "import type {RetryOptions} from './index';\nexport const limit = (options: RetryOptions): number => options.limit;\n"
    };
    assert.deepEqual(deadIn(files), ['main.ts:limit', 'types/options.ts:Options', 'types/retry.ts:unusedRetry']);
});

test('export * and export * as ns pass the names through; a barrel nobody imports keeps its re-export flagged', () => {
    const files = {
        'a.ts': 'export const viaStar = 1;\nexport const notAsked = 2;\n',
        'b.ts': 'export const wholeModule = 1;\n',
        'barrel.ts': "export * from './a';\nexport * as ns from './b';\n",
        'unusedBarrel.ts': "export {notAsked} from './a';\n",
        'main.ts': "import {viaStar, ns} from './barrel';\nconsole.log(viaStar, ns.wholeModule);\n"
    };
    assert.deepEqual(deadIn(files), ['a.ts:notAsked', 'unusedBarrel.ts:notAsked']);
});

test('declared entry points: their exports and what they re-export are public API', () => {
    const files = {
        'index.ts': "export {helper} from './util';\nexport * from './models';\nexport const version = '1';\n",
        'util.ts': 'export const helper = 1;\nexport const internalOnly = 2;\n',
        'models.ts': 'export interface Model {id: string}\n'
    };
    assert.deepEqual(deadIn(files), ['index.ts:helper', 'index.ts:version', 'models.ts:Model', 'util.ts:helper', 'util.ts:internalOnly']);
    assert.deepEqual(deadIn(files, ['index.ts']), ['util.ts:internalOnly']);
});

test('package.json entries: an analyzed file, its source by extension, or by tsconfig outDir → rootDir; nothing guessed', () => {
    const library = {'src/index.ts': 'export const api = 1;\n', 'src/other.ts': 'export const unused = 1;\n'};
    // `exports` names the build output; tsconfig maps dist/ back to src/.
    const mapped = deadIn({
        ...library,
        'package.json': JSON.stringify({name: 'lib', exports: {'.': {types: './dist/index.d.ts', default: './dist/index.js'}}}),
        'tsconfig.json': JSON.stringify({compilerOptions: {outDir: 'dist', rootDir: 'src'}})
    });
    assert.deepEqual(mapped, ['src/other.ts:unused']);
    // `main` naming the source itself (by extension: index.js → index.ts).
    assert.deepEqual(deadIn({...library, 'package.json': JSON.stringify({name: 'lib', main: './src/index.js'})}), ['src/other.ts:unused']);
    // dist/ without an outDir/rootDir mapping: no entry, nothing assumed.
    assert.deepEqual(deadIn({...library, 'package.json': JSON.stringify({name: 'lib', main: './dist/index.js'})}), ['src/index.ts:api', 'src/other.ts:unused']);
    // Two analyzed candidates (index.ts and index.tsx): ambiguous, no entry.
    assert.deepEqual(deadIn({...library, 'src/index.tsx': 'export const view = 1;\n', 'package.json': JSON.stringify({name: 'lib', main: './src/index.js'})}), [
        'src/index.ts:api',
        'src/index.tsx:view',
        'src/other.ts:unused'
    ]);
});
