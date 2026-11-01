import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {EMPTY_PROJECT_CONFIG, loadProjectConfig} from '../src/config/ProjectConfig.js';
import {ModuleResolver, resolveRelative} from '../src/analysis/ModuleResolution.js';

// Phase 0 — Config-Aware Module Resolution. Every target is resolved against an
// explicit ANALYZED-FILE set (membership), never the raw filesystem, so these
// tests build a set of absolute paths and assert exactly which specifier maps
// to which — and, critically, which stay `unresolved` rather than guessed.

const files = (...paths: string[]): ReadonlySet<string> => new Set(paths);

test('resolveRelative: resolves ./ and ../ with extension and index inference, exactly as before', () => {
    const analyzed = files('/p/src/a.ts', '/p/src/sub/index.ts', '/p/src/b.ts');
    assert.equal(resolveRelative('/p/src/a.ts', './b', analyzed), '/p/src/b.ts');
    assert.equal(resolveRelative('/p/src/a.ts', './b.js', analyzed), '/p/src/b.ts', '.js specifier maps to the .ts source (ESM-style)');
    assert.equal(resolveRelative('/p/src/a.ts', './sub', analyzed), '/p/src/sub/index.ts', 'directory → index.*');
    assert.equal(resolveRelative('/p/src/a.ts', './missing', analyzed), null);
    assert.equal(resolveRelative('/p/src/a.ts', 'bare-pkg', analyzed), null, 'a bare specifier is not relative resolution');
});

test('ModuleResolver with an empty config behaves exactly like relative-only resolution', () => {
    const analyzed = files('/p/a.ts', '/p/b.ts');
    const resolver = new ModuleResolver(EMPTY_PROJECT_CONFIG);
    assert.deepEqual(resolver.resolve('/p/a.ts', './b', analyzed), {target: '/p/b.ts', resolution: 'relative'});
    assert.deepEqual(resolver.resolve('/p/a.ts', './nope', analyzed), {target: null, resolution: 'unresolved'});
    assert.deepEqual(resolver.resolve('/p/a.ts', '@app/b', analyzed), {target: null, resolution: 'unresolved'}, 'no config → alias specifier is unresolved, never guessed');
});

test('tsconfig baseUrl + paths resolve as alias edges against the analyzed set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        mkdirSync(join(dir, 'src', 'app'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@app/*': ['src/app/*'], '@root': ['src/root.ts']}}}));
        writeFileSync(join(dir, 'src', 'app', 'thing.ts'), 'export const x = 1;\n');
        writeFileSync(join(dir, 'src', 'root.ts'), 'export const y = 1;\n');
        writeFileSync(join(dir, 'src', 'importer.ts'), 'export const z = 1;\n');

        const config = loadProjectConfig(dir);
        assert.equal(config.baseUrl, dir, 'baseUrl resolved to an absolute path');
        const resolver = new ModuleResolver(config);
        const analyzed = files(join(dir, 'src', 'app', 'thing.ts'), join(dir, 'src', 'root.ts'), join(dir, 'src', 'importer.ts'));

        assert.deepEqual(resolver.resolve(join(dir, 'src', 'importer.ts'), '@app/thing', analyzed), {target: join(dir, 'src', 'app', 'thing.ts'), resolution: 'alias'});
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'importer.ts'), '@root', analyzed), {target: join(dir, 'src', 'root.ts'), resolution: 'alias'});
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'importer.ts'), '@app/absent', analyzed), {target: null, resolution: 'unresolved'});
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('a bare specifier resolvable via baseUrl alone is an alias edge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        mkdirSync(join(dir, 'src'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {baseUrl: 'src'}}));
        writeFileSync(join(dir, 'src', 'lib.ts'), 'export const x = 1;\n');
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        const analyzed = files(join(dir, 'src', 'lib.ts'));
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'importer.ts'), 'lib', analyzed), {target: join(dir, 'src', 'lib.ts'), resolution: 'alias'});
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('tsconfig extends is followed (baseUrl/paths inherited from a base config)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        mkdirSync(join(dir, 'src', 'app'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.base.json'), JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@app/*': ['src/app/*']}}}));
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({extends: './tsconfig.base.json'}));
        writeFileSync(join(dir, 'src', 'app', 'thing.ts'), 'export const x = 1;\n');
        const config = loadProjectConfig(dir);
        assert.ok(config.paths?.['@app/*'] !== undefined, 'paths inherited through extends');
        const resolver = new ModuleResolver(config);
        const analyzed = files(join(dir, 'src', 'app', 'thing.ts'));
        assert.deepEqual(resolver.resolve(join(dir, 'x.ts'), '@app/thing', analyzed), {target: join(dir, 'src', 'app', 'thing.ts'), resolution: 'alias'});
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('an ambiguous paths match (two distinct analyzed targets) is unresolved, never an arbitrary pick', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        mkdirSync(join(dir, 'a'), {recursive: true});
        mkdirSync(join(dir, 'b'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'dup': ['a/x.ts', 'b/x.ts']}}}));
        writeFileSync(join(dir, 'a', 'x.ts'), 'export const x = 1;\n');
        writeFileSync(join(dir, 'b', 'x.ts'), 'export const x = 2;\n');
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        const analyzed = files(join(dir, 'a', 'x.ts'), join(dir, 'b', 'x.ts'));
        assert.deepEqual(resolver.resolve(join(dir, 'importer.ts'), 'dup', analyzed), {target: null, resolution: 'unresolved'});
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('package.json exports: a self-referential import to an analyzed source file is an exports edge; a dist-only target stays unresolved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        mkdirSync(join(dir, 'src'), {recursive: true});
        writeFileSync(join(dir, 'package.json'), JSON.stringify({name: '@acme/pkg', exports: {'./util': './src/util.ts', '.': './dist/index.js'}}));
        writeFileSync(join(dir, 'src', 'util.ts'), 'export const u = 1;\n');
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        const analyzed = files(join(dir, 'src', 'util.ts'));
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'a.ts'), '@acme/pkg/util', analyzed), {target: join(dir, 'src', 'util.ts'), resolution: 'exports'});
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'a.ts'), '@acme/pkg', analyzed), {target: null, resolution: 'unresolved'}, 'exports "." points at dist (not analyzed) → unresolved, not guessed');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('package.json imports (#): resolved only for an in-project target; an external redirect stays unresolved (Festlegung 5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        mkdirSync(join(dir, 'src'), {recursive: true});
        writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'p', imports: {'#internal': './src/internal.ts', '#ext': 'some-external-pkg'}}));
        writeFileSync(join(dir, 'src', 'internal.ts'), 'export const i = 1;\n');
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        const analyzed = files(join(dir, 'src', 'internal.ts'));
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'a.ts'), '#internal', analyzed), {target: join(dir, 'src', 'internal.ts'), resolution: 'imports'});
        assert.deepEqual(resolver.resolve(join(dir, 'src', 'a.ts'), '#ext', analyzed), {target: null, resolution: 'unresolved'}, 'external redirect is not reliably resolvable → unresolved');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('a broken/malformed tsconfig degrades to empty config (relative-only), never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        writeFileSync(join(dir, 'tsconfig.json'), '{ this is not valid json ');
        const config = loadProjectConfig(dir);
        assert.equal(config.baseUrl, undefined);
        assert.equal(config.paths, undefined);
        const resolver = new ModuleResolver(config);
        const analyzed = files(join(dir, 'a.ts'), join(dir, 'b.ts'));
        assert.equal(resolver.resolve(join(dir, 'a.ts'), './b', analyzed).resolution, 'relative', 'relative resolution still works with a broken tsconfig');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('loadProjectConfig on a directory with no tsconfig/package.json yields an effectively empty config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-'));
    try {
        const config = loadProjectConfig(dir);
        assert.equal(config.baseUrl, undefined);
        assert.equal(config.paths, undefined);
        assert.equal(config.packageName, undefined);
        assert.equal(config.exports, undefined);
        assert.equal(config.imports, undefined);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

// Point 2 — a cyclic `extends` chain must not throw, must not hang, must be
// deterministic, and must keep the root's OWN config only insofar as the
// TypeScript parser actually yields it (we do not reconstruct it ourselves).

test('a cyclic tsconfig extends chain (a → b → a) does not throw or hang, is deterministic, and keeps the root\'s own paths as TypeScript yields them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-cyclic-'));
    try {
        mkdirSync(join(dir, 'own'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({extends: './tsconfig.b.json', compilerOptions: {baseUrl: '.', paths: {'@own/*': ['own/*']}}}));
        writeFileSync(join(dir, 'tsconfig.b.json'), JSON.stringify({extends: './tsconfig.json'}));
        writeFileSync(join(dir, 'own', 'thing.ts'), 'export const x = 1;\n');

        const started = Date.now();
        const config = loadProjectConfig(dir);
        assert.ok(Date.now() - started < 5000, 'returns promptly — no hang on the extends cycle');
        // Determinism: a second load is byte-identical to the first.
        assert.equal(JSON.stringify(loadProjectConfig(dir)), JSON.stringify(config));
        // The root's own paths survive the cycle because TypeScript's parser
        // still surfaces them; resolution is consistent with whatever config
        // reports (never a hardcoded assumption about TS internals).
        const resolver = new ModuleResolver(config);
        const analyzed = files(join(dir, 'own', 'thing.ts'));
        const resolved = resolver.resolve(join(dir, 'x.ts'), '@own/thing', analyzed);
        if (config.paths?.['@own/*'] !== undefined) {
            assert.deepEqual(resolved, {target: join(dir, 'own', 'thing.ts'), resolution: 'alias'});
        } else {
            assert.equal(resolved.resolution, 'unresolved', 'if TS did not yield the paths, no alias may be fabricated');
        }
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

// Point 3 — `extends` targeting a package specifier (node_modules). Only the
// named config file is read (no recursive node_modules scanning), and a
// missing package extends degrades safely without fabricating an alias.

test('extends a package specifier: inherits ONLY the named base config, never a decoy elsewhere in node_modules (no recursive scanning)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-pkgext-'));
    try {
        mkdirSync(join(dir, 'node_modules', '@scope', 'base'), {recursive: true});
        mkdirSync(join(dir, 'node_modules', '@scope', 'other'), {recursive: true});
        // The base config's paths are anchored (by TypeScript) to the BASE
        // config's own directory, so the alias target lives under the package.
        mkdirSync(join(dir, 'node_modules', '@scope', 'base', 'base-src'), {recursive: true});
        writeFileSync(join(dir, 'node_modules', '@scope', 'base', 'tsconfig.json'), JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@base/*': ['base-src/*']}}}));
        // A decoy config elsewhere in node_modules that must NEVER be merged.
        writeFileSync(join(dir, 'node_modules', '@scope', 'other', 'tsconfig.json'), JSON.stringify({compilerOptions: {paths: {'@decoy/*': ['decoy/*']}}}));
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({extends: '@scope/base/tsconfig.json'}));
        writeFileSync(join(dir, 'node_modules', '@scope', 'base', 'base-src', 'thing.ts'), 'export const x = 1;\n');

        const config = loadProjectConfig(dir);
        assert.ok(config.paths?.['@base/*'] !== undefined, 'the named base config is inherited');
        assert.equal(config.paths?.['@decoy/*'], undefined, 'the decoy config elsewhere in node_modules is NOT scanned/merged');

        const resolver = new ModuleResolver(config);
        // The alias resolves to the analyzed file at the location the INHERITED
        // baseUrl+paths actually point (under the base package), proving the
        // inherited config is applied correctly — not to a guessed project path.
        const target = join(dir, 'node_modules', '@scope', 'base', 'base-src', 'thing.ts');
        assert.deepEqual(resolver.resolve(join(dir, 'x.ts'), '@base/thing', files(target)), {target, resolution: 'alias'});
        assert.equal(resolver.resolve(join(dir, 'x.ts'), '@decoy/thing', files(target)).resolution, 'unresolved', 'the decoy alias is never resolvable');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('extends a NON-existent package specifier: no throw, own local paths preserved, and the (failed) base produces no fabricated alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-cfg-pkgext-missing-'));
    try {
        mkdirSync(join(dir, 'own'), {recursive: true});
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({extends: '@does-not-exist/tsconfig', compilerOptions: {baseUrl: '.', paths: {'@own/*': ['own/*']}}}));
        writeFileSync(join(dir, 'own', 'thing.ts'), 'export const x = 1;\n');

        const config = loadProjectConfig(dir);
        assert.ok(config.paths?.['@own/*'] !== undefined, 'the own local paths survive a failed external extends');
        const resolver = new ModuleResolver(config);
        const analyzed = files(join(dir, 'own', 'thing.ts'));
        assert.deepEqual(resolver.resolve(join(dir, 'x.ts'), '@own/thing', analyzed), {target: join(dir, 'own', 'thing.ts'), resolution: 'alias'});
        // A specifier that could only have come from the missing base config
        // must stay unresolved — a failed extends never yields a false alias.
        assert.equal(resolver.resolve(join(dir, 'x.ts'), '@from-missing-base/x', analyzed).resolution, 'unresolved');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
