import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';

// A synthetic, generated-on-the-fly repository (Section 12 of the Memory-Bounded
// Analysis Pipeline spec): many small files across nested directories, mixed
// languages (TS + PHP), and a handful of Validation Trace ID annotations
// spread across different files. This is a CORRECTNESS regression test, not a
// memory-threshold one — no RSS/heap assertion is made here (an arbitrary
// memory ceiling would be unreliable across machines/Node versions, per the
// spec's own explicit constraint). What IS asserted is exactly what Section 12
// asks a scaled-up run to still guarantee: the analysis completes in full
// (nothing silently dropped), is deterministic, produces no duplicate finding
// identities, and loses no Evidence Graph connection — one dataflow graph per
// annotated-and-invoked validator, across however many files they are spread
// over.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

const FILE_COUNT = 40;
const SUBDIRS = ['a', 'b/nested', 'c'];

const buildSyntheticRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-scaling-'));
    for (const sub of SUBDIRS) {
        mkdirSync(join(dir, sub), {recursive: true});
    }
    for (let i = 0; i < FILE_COUNT; i += 1) {
        const sub = SUBDIRS[i % SUBDIRS.length] ?? '.';
        writeFileSync(join(dir, sub, `file${i}.ts`), `export function helper${i}(x: number): number {\n  return x + ${i};\n}\n`);
        writeFileSync(join(dir, sub, `file${i}.php`), `<?php\nfunction helper${i}($x) {\n  return $x + ${i};\n}\n`);
    }
    // Three Validation Trace ID annotations, spread across three different
    // files/directories, each actually invoked with request data and reaching
    // a persistence call — so each is expected to produce its OWN dataflow
    // graph fact, independent of how many unrelated files sit around it.
    for (const [index, sub] of SUBDIRS.entries()) {
        writeFileSync(
            join(dir, sub, 'validated.ts'),
            [
                "import {z} from 'zod';",
                'interface Repo { save(x: unknown): Promise<void>; }',
                `// stoa:validation VC-SCALING-${index}-001`,
                `const schema${index} = z.object({name: z.string()});`,
                `export async function handle${index}(req: {body: unknown}, repo: Repo): Promise<void> {`,
                `  const result = schema${index}.parse(req.body);`,
                '  await repo.save(result);',
                '}'
            ].join('\n')
        );
    }
    return dir;
};

test('a synthetic multi-directory, mixed-language repository analyzes completely, deterministically, with no duplicate findings and no lost Evidence Graph connections', () => {
    const dir = buildSyntheticRepo();
    try {
        const a = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
        const b = analyze({rootPath: dir, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});

        assert.equal(a.report.coverage.analysisIncomplete, undefined, 'a run this small never trips the memory guard');
        assert.equal(a.report.coverage.filesSelected, a.report.coverage.filesAnalyzed + a.report.coverage.filesSkipped, 'every selected file is accounted for as analyzed or skipped — none silently vanish');
        assert.equal(a.report.coverage.filesSkipped, 0, 'every generated .ts/.php file has a registered adapter and parses');
        assert.equal(a.report.coverage.filesSelected, FILE_COUNT * 2 + SUBDIRS.length);

        assert.equal(JSON.stringify(a.report.findings), JSON.stringify(b.report.findings), 'deterministic across two independent runs');
        assert.equal(JSON.stringify(a.facts), JSON.stringify(b.facts));

        const findingIds = a.report.findings.map((f) => f.id);
        assert.equal(new Set(findingIds).size, findingIds.length, 'no finding is reported twice under one identity');

        const dataflowGraphs = a.facts.filter((f) => f.kind === 'validation.dataflowGraph');
        const traceIds = dataflowGraphs.map((f) => (f.value as unknown as {id: string}).id).sort();
        assert.deepEqual(traceIds, ['VC-SCALING-0-001', 'VC-SCALING-1-001', 'VC-SCALING-2-001'], 'one dataflow graph per annotated validator, regardless of which of the three directories it lives in or how many unrelated files surround it');
        for (const fact of dataflowGraphs) {
            const graph = (fact.value as unknown as {graph: {edges: Array<{kind: string; status: string}>}}).graph;
            assert.ok(graph.edges.some((e) => e.kind === 'persists' && e.status === 'verified'), 'the same-function save() is still traced end-to-end at this scale');
        }
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
