import assert from 'node:assert/strict';
import {basename, dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import type {StoaConfig} from '../src/Types.js';
import {analyze} from '../src/Pipeline.js';

// R-WIDE-PUBLIC-SURFACE 1.1.0: a package entry point (`module.isPackageEntry`,
// model/PackageEntryFacts.ts) is not reported — its exports are the package's
// public API. Each fixture has an entry `index.ts` (16 re-exports + a default)
// and the declaring module `wide.ts` (16 exports), which stays reported.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'package-entry');

const reported = (dir: string, config: StoaConfig = DEFAULT_CONFIG): string[] =>
    analyze({rootPath: join(fixtures, dir), knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config})
        .report.findings.filter((finding) => finding.rule.id === 'R-WIDE-PUBLIC-SURFACE')
        .map((finding) => basename(finding.location.file))
        .sort();

test('the entry named by package.json (main: index.js → index.ts) is not reported; the declaring module is', () => {
    assert.deepEqual(reported('pkg'), ['wide.ts']);
});

test('an entry declared in entryPoints is not reported; without a declaration (no package.json) it is', () => {
    assert.deepEqual(reported('plain'), ['index.ts', 'wide.ts']);
    assert.deepEqual(reported('plain', {...DEFAULT_CONFIG, entryPoints: ['index.ts']}), ['wide.ts']);
});
