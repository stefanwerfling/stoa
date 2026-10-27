import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Options, ValidateFunction} from 'ajv/dist/2020.js';
import type {Principle} from '../Types.js';

// ajv/dist/2020.js is CommonJS (its module.exports is the Ajv2020 constructor).
// The default-import interop for this CJS module under NodeNext ESM is awkward
// without esModuleInterop, so load it via createRequire with ajv's own types.
type Ajv2020Constructor = new (options?: Options) => {compile: (schema: object) => ValidateFunction};
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as Ajv2020Constructor;

// The principle JSON schema lives at the package root (one dir above src/ or
// dist/). Resolving it from this module's URL keeps it findable from any cwd.
const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'principle.schema.json');

let validator: ValidateFunction | null = null;

const principleValidator = (): ValidateFunction => {
    if (validator === null) {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
        validator = new Ajv2020({allErrors: true, strict: false}).compile(schema);
    }
    return validator;
};

/**
 * Validates one parsed principle JSON against principle.schema.json at run time
 * (a TypeScript cast is not a runtime guarantee) and returns it typed. Throws an
 * Error naming the file and the concrete schema violations on failure. The
 * schema already enforces the required fields, their types and a non-empty,
 * namespaced id; cross-file concerns (duplicate ids, references) are checked by
 * the caller.
 */
export const assertValidPrinciple = (data: unknown, file: string): Principle => {
    const validate = principleValidator();
    if (!validate(data)) {
        const details = (validate.errors ?? []).map((error) => `${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'invalid'}`).join('; ');
        throw new Error(`knowledge: ${file} does not match principle.schema.json: ${details}`);
    }
    return data as Principle;
};
