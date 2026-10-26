import {Project, ts} from 'ts-morph';
import type {SourceFile} from 'ts-morph';
import type {Fact, SourceRange} from '../../Types.js';
import {factBuilder} from '../FactBuilder.js';
import type {FileRef} from '../LanguageAdapter.js';

// Robustness-relevant, resolution-independent diagnostic codes. Module/name
// resolution codes (e.g. 2307 "cannot find module") are deliberately excluded so
// that checking a file without its imports resolved does not produce noise.
const ROBUSTNESS_CODES: ReadonlySet<number> = new Set([
    2322, // type not assignable
    2345, // argument not assignable
    2366, // not all code paths return a value
    2454, // used before being assigned
    2531, // object is possibly 'null'
    2532, // object is possibly 'undefined'
    2533, // object is possibly 'null' or 'undefined'
    18047, // possibly 'null'
    18048 // possibly 'undefined'
]);

/**
 * External-tool fact source: runs the TypeScript type checker in-process (via
 * ts-morph — no subprocess) and emits `external.tsc` facts for a curated set of
 * robustness-relevant diagnostics. Opt-in; checks each file self-contained, so
 * cross-module type errors are out of scope (documented limitation). This
 * integrates a mature tool rather than reimplementing type inference (N3).
 */
export class TypeDiagnosticsExtractor {
    public readonly id = 'tsc';
    public readonly version = ts.version;

    private readonly project: Project;

    public constructor() {
        this.project = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: {
                strict: true,
                noImplicitReturns: true,
                target: ts.ScriptTarget.ES2022,
                lib: ['lib.es2022.full.d.ts'],
                noEmit: true,
                skipLibCheck: true
            }
        });
    }

    public extract(file: FileRef): Fact[] {
        const sourceFile = this.project.createSourceFile(file.path, file.content, {overwrite: true});
        const build = factBuilder({id: this.id, version: this.version}, file.path);
        const facts: Fact[] = [];

        let index = 0;
        for (const diagnostic of sourceFile.getPreEmitDiagnostics()) {
            const code = diagnostic.getCode();
            if (!ROBUSTNESS_CODES.has(code)) {
                continue;
            }
            const message = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, ' ');
            facts.push(
                build({
                    kind: 'external.tsc',
                    kindOf: 'statement',
                    symbol: `tsc#${index}`,
                    range: rangeOf(sourceFile, diagnostic.getStart(), diagnostic.getLength() ?? 0),
                    value: `[${code}] ${message}`,
                    certainty: 'external-tool',
                    evidenceSource: 'external-tool'
                })
            );
            index += 1;
        }

        this.project.removeSourceFile(sourceFile);
        return facts;
    }
}

const rangeOf = (sourceFile: SourceFile, start: number | undefined, length: number): SourceRange => {
    if (start === undefined) {
        return {startLine: 1, startCol: 0, endLine: 1, endCol: 0};
    }
    const from = sourceFile.getLineAndColumnAtPos(start);
    const to = sourceFile.getLineAndColumnAtPos(start + length);
    return {startLine: from.line, startCol: from.column, endLine: to.line, endCol: to.column};
};
