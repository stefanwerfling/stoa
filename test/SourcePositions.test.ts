import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Project} from 'ts-morph';
import {lineAndColumnAt} from '../src/analysis/typescript/SourcePositions.js';
import {TypeScriptAdapter} from '../src/analysis/TypeScriptAdapter.js';

// lineAndColumnAt must answer exactly like ts-morph's getLineAndColumnAtPos —
// quirks included (a lone \r starts no line but resets the column) — at every
// position of texts with LF, CRLF, lone CR, U+2028 and no line break at all.
const TEXTS: readonly string[] = [
    '',
    'const a = 1;',
    'const a = 1;\nconst b = 2;\n',
    'const a = 1;\r\nconst b = 2;\r\n\r\nlet c;',
    'const a = 1;\rconst b = 2;\r\rlet c;\n',
    'const a = 1; const b = 2;\nlet c = " ";',
    '\n\n\r\n\rx'
];

for (const [index, text] of TEXTS.entries()) {
    test(`lineAndColumnAt equals ts-morph at every position: text #${index}`, () => {
        const project = new Project({useInMemoryFileSystem: true});
        const sourceFile = project.createSourceFile(`/t${index}.ts`, text);
        for (let pos = 0; pos <= text.length; pos += 1) {
            assert.deepEqual(lineAndColumnAt(sourceFile, pos), sourceFile.getLineAndColumnAtPos(pos), `pos ${pos}`);
        }
    });
}

test('a re-parse of the same path gets a fresh break table', () => {
    const project = new Project({useInMemoryFileSystem: true});
    const first = project.createSourceFile('/r.ts', 'a;\nb;\n');
    assert.deepEqual(lineAndColumnAt(first, 3), {line: 2, column: 1});
    const second = project.createSourceFile('/r.ts', 'a;\r\n\r\nb;\n', {overwrite: true});
    assert.deepEqual(lineAndColumnAt(second, 6), second.getLineAndColumnAtPos(6));
});

// refsOf reads identifiers inside JSDoc too (as ts-morph's getDescendants
// does); they are now walked JSDoc node by JSDoc node instead of sending the
// whole member down getDescendants. Expected values = the output before.
const JSDOC_CLASS = `import {Foo, Bar, Baz} from './m';
import * as ns from './n';
/** Uses {@link Baz}. */
export class Svc {
    /** @param {Foo} a */
    run(a: unknown): void {
        /** @type {Foo} */
        const x = make();
        /** @see {@link Bar} */
        class Inner {}
        /** @augments ns.Base */
        class Sub {}
        new ns.Thing();
    }
    /** {@link Baz} */
    field = /** @type {Bar} */ (null);
    plain(): void { return; }
}
`;

for (const path of ['/x/svc.ts', '/x/svc.js']) {
    test(`member references inside JSDoc are kept: ${path}`, () => {
        const adapter = new TypeScriptAdapter();
        const facts = adapter.extractFacts(adapter.parse({path, content: JSDOC_CLASS}), {rootDir: '/'});
        const members = facts.filter((fact) => fact.kind === 'struct.typeDecl').map((fact) => (fact.value as {members: unknown}).members);
        assert.deepEqual(members, [
            [
                {
                    name: 'run',
                    memberKind: 'method',
                    range: [6, 5, 14, 6],
                    body: 'normal',
                    params: [{name: 'a', type: null, isFieldFormal: false}],
                    refsImports: ['Bar', 'Foo', 'ns'],
                    instantiates: [{prefix: 'ns', name: 'Thing', member: null}]
                },
                {name: 'field', memberKind: 'field', range: [16, 5, 16, 39], refsImports: ['Bar']},
                {name: 'plain', memberKind: 'method', range: [17, 5, 17, 30], body: 'normal'}
            ]
        ]);
    });
}
