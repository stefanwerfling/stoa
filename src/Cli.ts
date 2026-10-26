#!/usr/bin/env node
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {loadConfig} from './Config.js';
import {loadExpected} from './evaluation/Corpus.js';
import {evaluate} from './evaluation/Evaluator.js';
import {toMarkdown as evaluationMarkdown} from './evaluation/EvaluationReporter.js';
import {analyze} from './Pipeline.js';
import {toJson, toMarkdown} from './reporting/Reporter.js';
import {toSarif} from './reporting/SarifReporter.js';
import {createSemanticAdapter} from './semantic/SemanticAdapters.js';
import {augmentWithSemantics} from './semantic/SemanticRunner.js';
import type {AnalysisReport} from './Types.js';

type CliValues = {
    format?: string;
    config?: string;
    knowledge?: string;
    rules?: string;
    expected?: string;
    semantic?: string;
    lang?: string;
    help?: boolean;
};

const USAGE = [
    'stoa – Stoic Code Analysis Engine',
    '',
    'Usage:',
    '  stoa analyze <path> [--format markdown|json|sarif] [--lang en|de] [--config <file>] [--knowledge <dir>] [--rules <dir>] [--semantic noop|anthropic]',
    '  stoa eval <path> --expected <file> [--format markdown|json] [--knowledge <dir>] [--rules <dir>]',
    ''
].join('\n');

const knowledgeDirOf = (values: CliValues): string => {
    return resolve(values.knowledge ?? join(process.cwd(), 'knowledge', 'marcus'));
};

const ruleSetDirOf = (values: CliValues): string => {
    return resolve(values.rules ?? join(process.cwd(), 'rules', 'default'));
};

const render = (format: string | undefined, report: AnalysisReport, lang: string): string => {
    if (format === 'json') {
        return toJson(report);
    }
    if (format === 'sarif') {
        return toSarif(report, {baseDir: process.cwd()});
    }
    return toMarkdown(report, {lang});
};

const runAnalyze = async (values: CliValues, target: string): Promise<number> => {
    const lang = values.lang ?? 'en';
    let result = analyze({
        rootPath: resolve(target),
        knowledgeDir: knowledgeDirOf(values),
        ruleSetDir: ruleSetDirOf(values),
        config: loadConfig(values.config ?? null),
        lang
    });

    const semanticId = values.semantic ?? 'noop';
    if (semanticId !== 'noop') {
        // Optional, async, off the deterministic path: augment findings with a
        // grounded LLM verdict. Failures degrade gracefully to the plain report.
        result = await augmentWithSemantics(result, createSemanticAdapter(semanticId));
    }

    process.stdout.write(`${render(values.format, result.report, lang)}\n`);
    return 0;
};

const runEval = (values: CliValues, target: string): number => {
    if (values.expected === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return 1;
    }
    const findings = analyze({
        rootPath: resolve(target),
        knowledgeDir: knowledgeDirOf(values),
        ruleSetDir: ruleSetDirOf(values),
        config: loadConfig(values.config ?? null)
    }).report.findings;
    const result = evaluate(findings, loadExpected(resolve(values.expected)));
    const output = values.format === 'json' ? JSON.stringify(result, null, 2) : evaluationMarkdown(result);
    process.stdout.write(`${output}\n`);
    return result.overall.falsePositives === 0 ? 0 : 1;
};

const main = async (): Promise<number> => {
    const {values, positionals} = parseArgs({
        allowPositionals: true,
        options: {
            format: {type: 'string', default: 'markdown'},
            config: {type: 'string'},
            knowledge: {type: 'string'},
            rules: {type: 'string'},
            expected: {type: 'string'},
            semantic: {type: 'string'},
            lang: {type: 'string', default: 'en'},
            help: {type: 'boolean', default: false}
        }
    });

    const command = positionals[0];
    const target = positionals[1];

    if (values.help === true || command === undefined || target === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return values.help === true ? 0 : 1;
    }

    if (command === 'analyze') {
        return runAnalyze(values, target);
    }
    if (command === 'eval') {
        return runEval(values, target);
    }

    process.stdout.write(`${USAGE}\n`);
    return 1;
};

process.exit(await main());
