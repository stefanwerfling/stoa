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
const rulesDir = join(root, 'rules', 'default');

const loadJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const buildAjv = (): Ajv2020 => {
    const ajv = new Ajv2020({allErrors: true, strict: false});
    for (const name of ['fact.schema.json', 'principle.schema.json', 'finding.schema.json', 'rule.schema.json']) {
        ajv.addSchema(loadJson(join(schemasDir, name)) as object);
    }
    return ajv;
};

const getValidator = (ajv: Ajv2020, id: string) => {
    const validate = ajv.getSchema(id);
    if (validate === undefined) {
        throw new Error(`schema failed to compile: ${id}`);
    }
    return validate;
};

test('all principle files validate against principle.schema.json', () => {
    const validate = getValidator(buildAjv(), 'https://stoa.dev/schemas/principle.schema.json');
    const files = readdirSync(principlesDir).filter((name) => name.endsWith('.json'));
    assert.ok(files.length >= 6, 'expected at least 6 principle files');

    for (const file of files) {
        const data = loadJson(join(principlesDir, file));
        const ok = validate(data);
        assert.ok(ok, `${file} is invalid: ${JSON.stringify(validate.errors)}`);
    }
});

test('all rule files validate against rule.schema.json', () => {
    const validate = getValidator(buildAjv(), 'https://stoa.dev/schemas/rule.schema.json');
    const files = readdirSync(rulesDir).filter((name) => name.endsWith('.json'));
    assert.ok(files.length >= 4, 'expected at least 4 rule files');

    for (const file of files) {
        const data = loadJson(join(rulesDir, file));
        const ok = validate(data);
        assert.ok(ok, `${file} is invalid: ${JSON.stringify(validate.errors)}`);
    }
});

test('marcus.control is flagged with low attribution confidence (Epictetus is primary)', () => {
    const data = loadJson(join(principlesDir, 'control.json')) as {attributionConfidence: number};
    assert.ok(data.attributionConfidence <= 0.4, 'attribution to Marcus should be low');
});
