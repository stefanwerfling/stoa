import {existsSync, readFileSync} from 'node:fs';
import type {StoaConfig} from './Types.js';

export const DEFAULT_CONFIG: StoaConfig = {
    include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.php', '**/*.dart', '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.cxx', '**/*.hpp', '**/*.hh'],
    exclude: ['**/*.d.ts', 'dist/**', 'coverage/**', '.stoa/**'],
    ruleSet: 'default@1',
    knowledgeBase: 'marcus@1',
    semantic: {adapter: 'noop'}
};

/**
 * Loads stoa.config.json if present, otherwise the defaults. Shallow-merges the
 * parsed values over the defaults; deep/validated config handling is a later
 * stage.
 */
export const loadConfig = (configPath: string | null): StoaConfig => {
    if (configPath === null || !existsSync(configPath)) {
        return DEFAULT_CONFIG;
    }

    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoaConfig>;
    return {...DEFAULT_CONFIG, ...parsed};
};
