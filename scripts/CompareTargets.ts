// The target list of the comparison and measurement scripts
// (compare-findings.ts, compare-jobs.ts, measure-phases.ts): a JSON array of
// {name, path, solid?, deadExports?, entryPoints?, cpp?, architecture?, contracts?}; relative
// paths resolve against the targets file's directory. The default
// (scripts/compare-targets.json) covers this repository only — keep a list of
// your own projects in `.stoa/compare-targets.json` (ignored by git).

import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadArchitectureConfig} from '../src/architecture/ArchitectureConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import type {CppConfig} from '../src/Types.js';
import {loadValidationContract} from '../src/contracts/ValidationContract.js';
import type {AnalyzeAsyncOptions} from '../src/Pipeline.js';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TARGETS = join(PACKAGE_ROOT, 'scripts', 'compare-targets.json');

export interface Target {
    name: string;
    path: string;
    solid?: boolean;
    deadExports?: boolean;
    /** `entryPoints` of stoa.config.json: globs relative to `path`. */
    entryPoints?: string[];
    /** `cpp` of stoa.config.json: include paths / compilation database relative to `path`. */
    cpp?: CppConfig;
    architecture?: string;
    contracts?: string;
}

/** The targets of `file`, every path made absolute. */
export const readTargets = (file: string): Target[] => {
    const base = dirname(file);
    return (JSON.parse(readFileSync(file, 'utf8')) as Target[]).map((target) => ({
        ...target,
        path: resolve(base, target.path),
        ...(target.architecture !== undefined ? {architecture: resolve(base, target.architecture)} : {}),
        ...(target.contracts !== undefined ? {contracts: resolve(base, target.contracts)} : {})
    }));
};

/** The analysis of one target as the CLI would run it with the target's switches, with this package's knowledge base and rule set. */
export const analysisOptionsOf = (target: Target): AnalyzeAsyncOptions => ({
    rootPath: target.path,
    knowledgeDir: join(PACKAGE_ROOT, 'knowledge', 'marcus'),
    ruleSetDir: join(PACKAGE_ROOT, 'rules', 'default'),
    config: {...DEFAULT_CONFIG, ...(target.entryPoints === undefined ? {} : {entryPoints: target.entryPoints}), ...(target.cpp === undefined ? {} : {cpp: target.cpp})},
    solid: target.solid === true,
    deadExports: target.deadExports === true,
    ...(target.architecture !== undefined ? {architecture: loadArchitectureConfig(target.architecture)} : {}),
    ...(target.contracts !== undefined ? {validationContract: loadValidationContract(target.contracts)} : {})
});
