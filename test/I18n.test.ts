import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {localize} from '../src/i18n/Localized.js';
import {analyze} from '../src/Pipeline.js';
import {toMarkdown} from '../src/reporting/Reporter.js';
import type {AnalysisResult} from '../src/Types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const analyzeCatch = (lang: string): AnalysisResult =>
    analyze({
        rootPath: join(here, 'fixtures', 'metrics', 'Catch.ts'),
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        lang
    });

const swallow = (result: AnalysisResult) => result.report.findings.find((f) => f.rule.id === 'R-ERR-SWALLOWED');

test('localize resolves by language with en fallback', () => {
    assert.equal(localize({en: 'x', de: 'y'}, 'de'), 'y');
    assert.equal(localize({en: 'x'}, 'de'), 'x'); // fallback to en
    assert.equal(localize('plain', 'de'), 'plain'); // bare string passes through
});

test('findings are localized into German when lang=de', () => {
    const finding = swallow(analyzeCatch('de'));
    assert.ok(finding);
    assert.equal(finding?.observation.statement, 'catch-Block wirft den Fehler weder erneut, behandelt noch protokolliert ihn.');
    assert.equal(finding?.interpretation.principles[0]?.name, 'Hindernis wird zur Förderung');
    assert.ok(finding?.remediation.suggestion.startsWith('Protokollieren'));
});

test('English remains the default', () => {
    const finding = swallow(analyzeCatch('en'));
    assert.ok(finding);
    assert.equal(finding?.observation.statement, 'catch clause neither rethrows, handles nor logs the error.');
    assert.equal(finding?.interpretation.principles[0]?.name, 'The obstacle becomes a furtherance');
});

test('markdown chrome and dimension labels are translated', () => {
    const md = toMarkdown(analyzeCatch('de').report, {lang: 'de'});
    assert.ok(md.includes('# stoa – Analysebericht'));
    assert.ok(md.includes('## Befunde'));
    assert.ok(md.includes('Schwere:'));
    assert.ok(md.includes('Fehlerbehandlung'));
});

test('localized output is deterministic', () => {
    assert.equal(JSON.stringify(analyzeCatch('de')), JSON.stringify(analyzeCatch('de')));
});
