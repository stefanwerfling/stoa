import assert from 'node:assert/strict';
import {basename, dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';

// R-FN-TOO-MANY-PARAMS 1.1.0: a method whose signature a supertype dictates
// (`type.overridesMember`, model/Overrides.ts) is not reported — the
// finding stays on the parent's declaration.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'override-params');

before(async () => {
    await initDart();
});

const reported = (dir: string): string[] =>
    analyze({rootPath: join(fixtures, dir), knowledgeDir: join(root, 'knowledge', 'marcus'), ruleSetDir: join(root, 'rules', 'default'), config: DEFAULT_CONFIG})
        .report.findings.filter((finding) => finding.rule.id === 'R-FN-TOO-MANY-PARAMS')
        .map((finding) => `${basename(finding.location.file)}:${finding.location.symbol}`)
        .sort();

test('PHP: an override of a project parent (no marker), an interface implementation and a #[\\Override] method are not reported', () => {
    assert.deepEqual(reported('php'), ['Base.php:App\\Base.addArgument', 'Child.php:App\\Child.own']);
});

test('TypeScript: overrides of project classes (also transitively) and `override` methods are not reported; an unmarked external override is', () => {
    assert.deepEqual(reported('ts'), ['shapes.ts:Adapter.receive', 'shapes.ts:Base.draw']);
});

test('Dart: an @override method is not reported; an unmarked one is', () => {
    assert.deepEqual(reported('dart'), ['painter.dart:Painter.sketch']);
});
