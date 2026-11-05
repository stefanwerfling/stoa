import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {EMPTY_PROJECT_CONFIG} from '../src/config/ProjectConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {buildModuleGraph, cycleAdjacency} from '../src/model/ModuleGraph.js';
import {analyze} from '../src/Pipeline.js';

// Identity spec, phase 4: `#include` becomes a `cpp.include` fact and a
// ModuleGraph entry. A quoted include resolves to the file next to the
// including one; a standard header is external; everything else stays
// unresolved with an unknown status. Unconditional include cycles are
// dependency cycles.

const testDir = dirname(fileURLToPath(import.meta.url));

type AnalysisResult = ReturnType<typeof analyze>;

before(async () => {
    await initCpp();
});

const withProject = (files: Record<string, string>, run: (dir: string, result: AnalysisResult) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-include-'));
    try {
        for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, path)), {recursive: true});
            writeFileSync(join(dir, path), content);
        }
        run(dir, analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config: DEFAULT_CONFIG}));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
};

const graphOf = (result: AnalysisResult) => buildModuleGraph(result.facts, new Set(result.facts.map((fact) => fact.subject.file)), new ModuleResolver(EMPTY_PROJECT_CONFIG));

const A_H = '// a\n#ifndef A_H\n#define A_H\n#include "b.h"\n#include <vector>\n#include <sys/types.h>\n#include "missing.h"\n#include CONFIG_HEADER\n#endif\n';
const B_H = '#pragma once\n#include "a.h"\n#ifdef WITH_C\n#include "sub/c.h"\n#endif\n';
const C_H = '#pragma once\n#include "../b.h"\n';

test('#include facts: form, module and conditional — the include guard is no condition, #ifdef is', () => {
    withProject({'a.h': A_H, 'b.h': B_H, 'sub/c.h': C_H}, (dir, result) => {
        const includes = result.facts.filter((fact) => fact.kind === 'cpp.include').map((fact) => [fact.subject.file.slice(dir.length + 1), fact.subject.symbol, fact.value]);
        assert.deepEqual(includes, [
            ['a.h', 'import:b.h', {module: 'b.h', form: 'quoted', conditional: false}],
            ['a.h', 'import:vector', {module: 'vector', form: 'system', conditional: false}],
            ['a.h', 'import:sys/types.h', {module: 'sys/types.h', form: 'system', conditional: false}],
            ['a.h', 'import:missing.h', {module: 'missing.h', form: 'quoted', conditional: false}],
            ['a.h', 'import:CONFIG_HEADER', {module: 'CONFIG_HEADER', form: 'macro', conditional: false}],
            ['b.h', 'import:a.h', {module: 'a.h', form: 'quoted', conditional: false}],
            ['b.h', 'import:sub/c.h', {module: 'sub/c.h', form: 'quoted', conditional: true}],
            ['sub/c.h', 'import:../b.h', {module: '../b.h', form: 'quoted', conditional: false}]
        ]);
    });
});

test('#include in the ModuleGraph: quoted next to the includer resolves; a standard header is external, the rest unknown', () => {
    withProject({'a.h': A_H, 'b.h': B_H, 'sub/c.h': C_H}, (dir, result) => {
        const graph = graphOf(result);
        const rel = (path: string): string => path.slice(dir.length + 1);
        assert.deepEqual(
            graph.edges.map((edge) => [rel(edge.from), rel(edge.to), edge.resolution, edge.origin, edge.conditional]),
            [
                ['a.h', 'b.h', 'relative', 'cpp.include', false],
                ['b.h', 'a.h', 'relative', 'cpp.include', false],
                ['b.h', 'sub/c.h', 'relative', 'cpp.include', true],
                ['sub/c.h', 'b.h', 'relative', 'cpp.include', false]
            ]
        );
        assert.deepEqual(
            graph.unresolved.map((entry) => [entry.specifier, entry.external]),
            [
                ['CONFIG_HEADER', undefined],
                ['missing.h', undefined],
                ['sys/types.h', undefined],
                ['vector', true]
            ]
        );
        // The conditional include b.h → sub/c.h is no part of the cycle view.
        const adjacency = cycleAdjacency(graph);
        assert.deepEqual([...(adjacency.get(join(dir, 'b.h')) ?? [])], [join(dir, 'a.h')]);
    });
});

test('R-DEP-CYCLE reports an unconditional include cycle once; a conditional one is not reported', () => {
    withProject({'a.h': A_H, 'b.h': B_H, 'sub/c.h': C_H}, (dir, result) => {
        const cycles = result.report.findings.filter((finding) => finding.rule.id === 'R-DEP-CYCLE');
        assert.deepEqual(
            cycles.map((finding) => [finding.location.file, finding.location.symbol]),
            [[join(dir, 'a.h'), 'a.h,b.h']]
        );
    });
});

test('an include without a cycle back, a .c including its header, reports nothing', () => {
    withProject({'m.c': '#include "m.h"\nint f(void) { return 1; }\n', 'm.h': '#ifndef M_H\n#define M_H\nint f(void);\n#endif\n'}, (_dir, result) => {
        assert.ok(!result.report.findings.some((finding) => finding.rule.id === 'R-DEP-CYCLE'));
    });
});
