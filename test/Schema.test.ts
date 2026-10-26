import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const schemasDir = join(root, 'schemas');
const principlesDir = join(root, 'knowledge', 'marcus', 'principles');

const loadJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const buildValidator = () => {
    const ajv = new Ajv2020({allErrors: true, strict: false});
    for (const name of ['fact.schema.json', 'principle.schema.json', 'finding.schema.json', 'rule.schema.json']) {
        ajv.addSchema(loadJson(join(schemasDir, name)) as object);
    }
    const validate = ajv.getSchema('https://stoa.dev/schemas/principle.schema.json');
    if (validate === undefined) {
        throw new Error('principle schema failed to compile');
    }
    return validate;
};

test('all principle files validate against principle.schema.json', () => {
    const validate = buildValidator();
    const files = readdirSync(principlesDir).filter((name) => name.endsWith('.json'));
    assert.ok(files.length >= 6, 'expected at least 6 principle files');

    for (const file of files) {
        const data = loadJson(join(principlesDir, file));
        const ok = validate(data);
        assert.ok(ok, `${file} is invalid: ${JSON.stringify(validate.errors)}`);
    }
});

test('marcus.control is flagged with low attribution confidence (Epictetus is primary)', () => {
    const data = loadJson(join(principlesDir, 'control.json')) as {attributionConfidence: number};
    assert.ok(data.attributionConfidence <= 0.4, 'attribution to Marcus should be low');
});
