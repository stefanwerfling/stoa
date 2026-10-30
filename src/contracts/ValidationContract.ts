import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Options, ValidateFunction} from 'ajv/dist/2020.js';

// ajv/dist/2020.js is CommonJS; loaded via createRequire for the same reason as
// src/knowledge/KnowledgeValidation.ts (no esModuleInterop under NodeNext ESM).
type Ajv2020Constructor = new (options?: Options) => {compile: (schema: object) => ValidateFunction};
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as Ajv2020Constructor;

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'validation-contract.schema.json');

let validator: ValidateFunction | null = null;

const contractValidator = (): ValidateFunction => {
    if (validator === null) {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
        validator = new Ajv2020({allErrors: true, strict: false}).compile(schema);
    }
    return validator;
};

export type NormalizationKind = 'trim' | 'lowercase' | 'uppercase';

/**
 * One business validation rule from a Validation Contract. The ID is a
 * project-chosen Validation Trace ID (e.g. `VC-ITEM-QUANTITY-001`) — never a
 * Stoa rule/finding/fact id. Every field but id/description/field/dataType is
 * optional: Stoa only compares the dimensions a contract actually declares, so
 * an omitted bound is "not specified by this contract", never "must be absent".
 */
export interface ContractRule {
    id: string;
    description: string;
    field: string;
    dataType: 'number' | 'string' | 'boolean';
    required?: boolean;
    nullable?: boolean;
    min?: number;
    max?: number;
    normalization?: NormalizationKind[];
    layers?: string[];
    securityRequirements?: string[];
    version?: string;
}

export interface ValidationContract {
    /** The path the contract was loaded from, for anchoring findings that are
     *  about a contract entry with no implementation found anywhere in the
     *  analyzed code (there is no source location to point at). */
    path: string;
    version: string;
    rules: ContractRule[];
}

/**
 * Loads and schema-validates a Validation Contract (see
 * schemas/validation-contract.schema.json). This describes the EXPECTED
 * business rules for the project under analysis — it is a user-supplied input
 * to Stoa, not part of Stoa's own ruleset, and proves nothing about what the
 * code actually does; that comparison is the job of ValidationContractRule.
 * Throws with the concrete schema violations on a malformed contract, so a
 * broken file is an explicit, visible error rather than silently-empty checks.
 */
export const loadValidationContract = (path: string): ValidationContract => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`validation contract ${path} is not valid JSON: ${(error as Error).message}`);
    }
    const validate = contractValidator();
    if (!validate(parsed)) {
        const details = (validate.errors ?? []).map((error) => `${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'invalid'}`).join('; ');
        throw new Error(`validation contract ${path} does not match validation-contract.schema.json: ${details}`);
    }
    const data = parsed as {version: string; rules: ContractRule[]};
    return {path, version: data.version, rules: data.rules};
};

export const findContractRule = (contract: ValidationContract, id: string): ContractRule | null => {
    return contract.rules.find((rule) => rule.id === id) ?? null;
};
