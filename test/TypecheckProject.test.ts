import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const project = join(here, 'fixtures', 'typecheck-project');

const typeFindings = (): string[] =>
    analyze({
        rootPath: project,
        knowledgeDir: join(root, 'knowledge', 'marcus'),
        ruleSetDir: join(root, 'rules', 'default'),
        config: DEFAULT_CONFIG,
        typecheck: true
    })
        .report.findings.filter((f) => f.rule.id === 'R-TYPE-UNSOUND')
        .map((f) => `${f.location.file.slice(project.length + 1)}:${f.location.range.startLine}`);

// Regression for the SwipeMeister false positives: --typecheck must report
// exactly what `tsc -p <nearest tsconfig>` reports for this fixture project —
// the one genuine error in src/Unsound.ts and nothing else.
test('--typecheck matches tsc -p <nearest tsconfig>: genuine errors only', () => {
    assert.deepEqual(typeFindings(), ['src/Unsound.ts:2']);
});

test('--typecheck resolves imports: Object.entries over an imported Record is not unknown', () => {
    assert.equal(typeFindings().some((location) => location.startsWith('src/Report.ts')), false);
});

test('--typecheck skips files outside every tsconfig project (tsc -p does not check them)', () => {
    assert.equal(typeFindings().some((location) => location.startsWith('test/')), false, 'not even the genuine error in the excluded test file');
});
