import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Project, SyntaxKind, ts} from 'ts-morph';
import type {Node} from 'ts-morph';
import {descendantsOfKind, descendantsOfKinds} from '../src/analysis/typescript/NodeIndex.js';

// The per-file node index must answer exactly like ts-morph: the same
// wrappers, in the same order, for every node of the file and every kind —
// node kinds from the index, token kinds (JSDoc included) passed through.

const source = [
    "import {Base} from './base';",
    '/** @augments Base.Inner */',
    'export class Service extends Base {',
    '    private readonly items = [1, 2].map((x) => x * 2);',
    '    run(input: {a: number}): number {',
    '        // a comment statement',
    '        const inner = function (y: number): number {',
    '            return [y].filter((z) => z > 0).length;',
    '        };',
    '        try {',
    '            return inner(input.a) + new Map().size;',
    '        } catch (error) {',
    "            throw new Error('failed: ' + String(error));",
    '        }',
    '    }',
    '}',
    'export const view = (): unknown => <div onClick={() => undefined}><span title={`x`} /></div>;',
    'if (Math.random() > 0.5) { console.log({synchronize: true, nested: {a: 1}}); }',
    ''
].join('\n');

const fileFor = (content: string): Node => {
    const project = new Project({useInMemoryFileSystem: true, compilerOptions: {jsx: ts.JsxEmit.Preserve}});
    return project.createSourceFile('/a.tsx', content);
};

const KINDS: readonly SyntaxKind[] = [
    SyntaxKind.CallExpression,
    SyntaxKind.PropertyAccessExpression,
    SyntaxKind.NewExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.FunctionExpression,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.VariableDeclaration,
    SyntaxKind.VariableStatement,
    SyntaxKind.BinaryExpression,
    SyntaxKind.CatchClause,
    SyntaxKind.ThrowStatement,
    SyntaxKind.IfStatement,
    SyntaxKind.ObjectLiteralExpression,
    SyntaxKind.PropertyAssignment,
    SyntaxKind.JsxSelfClosingElement,
    SyntaxKind.JsxOpeningElement,
    SyntaxKind.ExpressionWithTypeArguments,
    SyntaxKind.Identifier,
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral
];

test('descendantsOfKind equals getDescendantsOfKind for every node and kind (same wrappers, same order)', () => {
    const file = fileFor(source);
    const nodes: Node[] = [file];
    file.forEachDescendant((node) => {
        nodes.push(node);
    });
    for (const node of nodes) {
        for (const kind of KINDS) {
            const expected = node.getDescendantsOfKind(kind);
            const actual = descendantsOfKind(node, kind);
            assert.equal(actual.length, expected.length, `${node.getKindName()} / ${SyntaxKind[kind]}`);
            actual.forEach((hit, at) => assert.equal(hit, expected[at], `${node.getKindName()} / ${SyntaxKind[kind]} #${at}`));
        }
    }
});

test('descendantsOfKinds equals filtering forEachDescendant by kind', () => {
    const file = fileFor(source);
    const kinds: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression, SyntaxKind.MethodDeclaration]);
    for (const node of [file, ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration)]) {
        const expected: Node[] = [];
        node.forEachDescendant((descendant) => {
            if (kinds.has(descendant.getKind())) {
                expected.push(descendant);
            }
        });
        assert.deepEqual(descendantsOfKinds(node, kinds), expected);
    }
});

test('token kinds go to ts-morph: an identifier inside JSDoc is found', () => {
    const file = fileFor(source);
    const names = descendantsOfKind(file, SyntaxKind.Identifier).map((identifier) => identifier.getText());
    assert.equal(names.filter((name) => name === 'Inner').length, 1);
});

test('a re-parse of the same path is indexed afresh', () => {
    const project = new Project({useInMemoryFileSystem: true});
    const first = project.createSourceFile('/b.ts', 'f(); g();');
    assert.equal(descendantsOfKind(first, SyntaxKind.CallExpression).length, 2);
    const second = project.createSourceFile('/b.ts', 'f();', {overwrite: true});
    assert.deepEqual(
        descendantsOfKind(second, SyntaxKind.CallExpression).map((call) => call.getText()),
        ['f()']
    );
});
