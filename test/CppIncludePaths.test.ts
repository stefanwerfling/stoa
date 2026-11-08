import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {loadProjectConfig} from '../src/config/ProjectConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {buildModuleGraph} from '../src/model/ModuleGraph.js';
import {analyze} from '../src/Pipeline.js';
import type {CppConfig} from '../src/Types.js';

// C/C++ include paths: a compilation database (configured, or found at the
// root / in build/) and `cpp.includePaths` let an include resolve the way
// the compiler finds it — not only next to the including file.

const testDir = dirname(fileURLToPath(import.meta.url));

type AnalysisResult = ReturnType<typeof analyze>;

before(async () => {
    await initCpp();
});

/** Writes `files` (a function of the project directory, for absolute paths in a database), analyzes with `cpp`, hands both on. */
const withProject = (files: (dir: string) => Record<string, string>, cpp: CppConfig | undefined, run: (dir: string, result: AnalysisResult) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-include-paths-'));
    try {
        for (const [path, content] of Object.entries(files(dir))) {
            mkdirSync(dirname(join(dir, path)), {recursive: true});
            writeFileSync(join(dir, path), content);
        }
        const config = cpp === undefined ? DEFAULT_CONFIG : {...DEFAULT_CONFIG, cpp};
        run(dir, analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config}));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
};

/** The C/C++ edges as `from → to (resolution)`, relative to `dir`. */
const edgesOf = (dir: string, result: AnalysisResult, cpp?: CppConfig): string[] => {
    const files = new Set(result.facts.map((fact) => fact.subject.file));
    const graph = buildModuleGraph(result.facts, files, new ModuleResolver(loadProjectConfig(dir, cpp)));
    const rel = (path: string): string => path.slice(dir.length + 1);
    return graph.edges.filter((edge) => edge.origin === 'cpp.include').map((edge) => `${rel(edge.from)} → ${rel(edge.to)} (${edge.resolution})`);
};

const database = (dir: string, entries: {file: string; command: string}[]): string => JSON.stringify(entries.map((entry) => ({directory: join(dir, 'build'), file: entry.file, command: entry.command})));

const SOURCES = {
    'src/app/main.cpp': '#include "core/log.hpp"\n#include <core/util.hpp>\n#include "only.h"\n#include <only.h>\n#include "dup.hpp"\nint main() { return 0; }\n',
    'src/core/log.hpp': '#pragma once\n#include "core/util.hpp"\n#include "amb.h"\n',
    'src/core/util.hpp': '#pragma once\n',
    'quote/only.h': '#pragma once\n',
    'vendor/dup.hpp': '#pragma once\n',
    'src/dup.hpp': '#pragma once\n',
    'one/amb.h': '#pragma once\n',
    'two/amb.h': '#pragma once\n'
};

test('a database command is split like a POSIX shell: quoted directories with spaces, escapes, joined and separate -I', () => {
    withProject(
        (dir) => ({
            'src/main.cpp': '#include "x.hpp"\n#include "y.hpp"\nint main() { return 0; }\n',
            'my src/x.hpp': '#pragma once\n',
            "it's/y.hpp": '#pragma once\n',
            'compile_commands.json': database(dir, [{file: '../src/main.cpp', command: `/bin/c++  -I"../my src" -DX=\\"y\\" -I '../it'\\''s'  -c ../src/main.cpp`}])
        }),
        undefined,
        (dir, result) => {
            assert.deepEqual(edgesOf(dir, result), ["src/main.cpp → it's/y.hpp (include-path)", 'src/main.cpp → my src/x.hpp (include-path)']);
        }
    );
});

test('a compilation database: a translation unit searches -iquote (quoted only), -I, -isystem in order; the first existing file wins', () => {
    withProject(
        (dir) => ({
            ...SOURCES,
            'compile_commands.json': database(dir, [{file: '../src/app/main.cpp', command: '/bin/c++ -iquote ../quote -I ../vendor -I../src -isystem ../one -isystem ../two -c ../src/app/main.cpp'}])
        }),
        undefined,
        (dir, result) => {
            assert.deepEqual(edgesOf(dir, result), [
                // `"dup.hpp"` is absent: vendor/ comes first and is excluded — the compiler reads that copy, not src/dup.hpp.
                'src/app/main.cpp → quote/only.h (include-path)',
                'src/app/main.cpp → src/core/log.hpp (include-path)',
                'src/app/main.cpp → src/core/util.hpp (include-path)',
                // The header has no entry: every database directory; amb.h matches in one/ and two/ — ambiguous, unresolved.
                'src/core/log.hpp → src/core/util.hpp (include-path)'
            ]);
            assert.deepEqual(result.report.cppIncludes, {includePaths: 0, compileCommands: {path: join(dir, 'compile_commands.json'), status: 'used', entries: 1, matchedEntries: 1}});
        }
    );
});

test('build/compile_commands.json is found too; a database naming no existing file is stale and not used', () => {
    withProject(
        (dir) => ({...SOURCES, 'build/compile_commands.json': database(dir, [{file: '../src/app/main.cpp', command: 'c++ -I../src -c ../src/app/main.cpp'}])}),
        undefined,
        (dir, result) => {
            assert.ok(edgesOf(dir, result).includes('src/app/main.cpp → src/core/log.hpp (include-path)'));
            assert.equal(result.report.cppIncludes?.compileCommands?.status, 'used');
        }
    );
    withProject(
        () => ({...SOURCES, 'compile_commands.json': JSON.stringify([{directory: '/src/build', file: '/src/src/app/main.cpp', command: 'c++ -I/src/src -c /src/src/app/main.cpp'}])}),
        undefined,
        (dir, result) => {
            assert.deepEqual(edgesOf(dir, result), []);
            assert.deepEqual(result.report.cppIncludes, {includePaths: 0, compileCommands: {path: join(dir, 'compile_commands.json'), status: 'stale', entries: 1, matchedEntries: 0}});
        }
    );
});

test('cpp.includePaths: searched like -I by every file, in order; a configured database that does not exist is reported missing', () => {
    const cpp: CppConfig = {includePaths: ['src'], compileCommands: 'out/compile_commands.json'};
    withProject(
        () => ({'src/a/a.hpp': '#pragma once\n#include "b/b.hpp"\n', 'src/b/b.hpp': '#pragma once\n#include "a/a.hpp"\n'}),
        cpp,
        (dir, result) => {
            assert.deepEqual(edgesOf(dir, result, cpp), ['src/a/a.hpp → src/b/b.hpp (include-path)', 'src/b/b.hpp → src/a/a.hpp (include-path)']);
            // An include cycle through include paths is a dependency cycle.
            assert.deepEqual(
                result.report.findings.filter((finding) => finding.rule.id === 'R-DEP-CYCLE').map((finding) => finding.location.symbol),
                ['a.hpp,b.hpp']
            );
            assert.deepEqual(result.report.cppIncludes, {includePaths: 1, compileCommands: {path: join(dir, 'out', 'compile_commands.json'), status: 'missing', entries: 0, matchedEntries: 0}});
        }
    );
});

test('without a database or include paths nothing changes: no cppIncludes in the report, only the include next to the file', () => {
    withProject(
        () => SOURCES,
        undefined,
        (dir, result) => {
            assert.deepEqual(edgesOf(dir, result), []);
            assert.equal(result.report.cppIncludes, undefined);
        }
    );
});
