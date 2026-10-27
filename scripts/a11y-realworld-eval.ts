#!/usr/bin/env node
// Real-world accessibility evaluation harness.
//
// Runs stoa over a real project (any local checkout) and writes a Markdown report
// that groups the accessibility findings by surface and rule and samples a few per
// rule for MANUAL verification. It intentionally reports counts and samples, not
// precision/recall — a real project has no ground truth, so a human must classify
// the sampled findings against an external oracle (axe / Lighthouse / a screen
// reader). Separate from the curated golden corpus by design.
//
// Usage:
//   npx tsx scripts/a11y-realworld-eval.ts <path> [--sample N] [--out <file>]
//            [--rules <dir>] [--knowledge <dir>] [--include <glob>]... [--exclude <glob>]...
import {writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {initCpp} from '../src/analysis/CppAdapter.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {initHtml} from '../src/analysis/HtmlAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import {buildRealWorldReport} from '../src/evaluation/RealWorldReport.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const main = async (): Promise<number> => {
    const {values, positionals} = parseArgs({
        allowPositionals: true,
        options: {
            sample: {type: 'string', default: '5'},
            out: {type: 'string'},
            rules: {type: 'string'},
            knowledge: {type: 'string'},
            include: {type: 'string', multiple: true},
            exclude: {type: 'string', multiple: true}
        }
    });

    const target = positionals[0];
    if (target === undefined) {
        process.stderr.write('Usage: npx tsx scripts/a11y-realworld-eval.ts <path> [--sample N] [--out <file>]\n');
        return 1;
    }

    const sampleSize = Number.parseInt(values.sample ?? '5', 10);
    if (!Number.isInteger(sampleSize) || sampleSize < 0) {
        process.stderr.write(`Invalid --sample value: ${values.sample}\n`);
        return 1;
    }

    const rootPath = resolve(target);
    const config = {
        ...DEFAULT_CONFIG,
        include: values.include !== undefined && values.include.length > 0 ? values.include : DEFAULT_CONFIG.include,
        exclude: values.exclude !== undefined && values.exclude.length > 0 ? values.exclude : DEFAULT_CONFIG.exclude
    };

    // Load the tree-sitter (WASM) grammars once, sequentially (the shared
    // Parser.init() is not safe to race); files are skipped if a grammar fails.
    await initDart().catch(() => undefined);
    await initCpp().catch(() => undefined);
    await initHtml().catch(() => undefined);

    const startedAt = Date.now();
    const result = analyze({
        rootPath,
        knowledgeDir: values.knowledge !== undefined ? resolve(values.knowledge) : join(PACKAGE_ROOT, 'knowledge', 'marcus'),
        ruleSetDir: values.rules !== undefined ? resolve(values.rules) : join(PACKAGE_ROOT, 'rules', 'default'),
        config
    });
    const elapsedMs = Date.now() - startedAt;

    const report = buildRealWorldReport({
        targetPath: rootPath,
        generatedAt: new Date().toISOString(),
        engineVersion: result.report.versions.engine,
        coverage: result.report.coverage,
        findings: result.report.findings,
        sampleSize,
        elapsedMs
    });

    const outPath = values.out !== undefined ? resolve(values.out) : join(rootPath, 'a11y-realworld-eval.md');
    writeFileSync(outPath, `${report}\n`, 'utf8');

    const a11yCount = result.report.findings.filter((f) => f.rule.id.startsWith('R-A11Y-')).length;
    process.stdout.write(
        `Analyzed ${result.report.coverage.filesAnalyzed}/${result.report.coverage.filesSelected} files in ${elapsedMs} ms; `
        + `${a11yCount} accessibility findings. Report: ${outPath}\n`
    );
    return 0;
};

process.exit(await main());
