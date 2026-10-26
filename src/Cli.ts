#!/usr/bin/env node
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {loadConfig} from './Config.js';
import {analyze} from './Pipeline.js';
import {toJson, toMarkdown} from './reporting/Reporter.js';

const USAGE = [
    'stoa – Stoic Code Analysis Engine',
    '',
    'Usage:',
    '  stoa analyze <path> [--format markdown|json] [--config <file>] [--knowledge <dir>] [--rules <dir>]',
    ''
].join('\n');

const main = (): number => {
    const {values, positionals} = parseArgs({
        allowPositionals: true,
        options: {
            format: {type: 'string', default: 'markdown'},
            config: {type: 'string'},
            knowledge: {type: 'string'},
            rules: {type: 'string'},
            help: {type: 'boolean', default: false}
        }
    });

    if (values.help === true || positionals[0] !== 'analyze') {
        process.stdout.write(`${USAGE}\n`);
        return positionals[0] === 'analyze' ? 0 : 1;
    }

    const target = positionals[1];
    if (target === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return 1;
    }

    const rootPath = resolve(target);
    const knowledgeDir = resolve(values.knowledge ?? join(process.cwd(), 'knowledge', 'marcus'));
    const ruleSetDir = resolve(values.rules ?? join(process.cwd(), 'rules', 'default'));
    const config = loadConfig(values.config ?? null);

    const {report} = analyze({rootPath, knowledgeDir, ruleSetDir, config});
    const output = values.format === 'json' ? toJson(report) : toMarkdown(report);
    process.stdout.write(`${output}\n`);

    // Exit code stays 0 for "ran successfully"; a findings-based exit code is a
    // later stage so CI can distinguish "tool failed" from "findings present".
    return 0;
};

process.exit(main());
