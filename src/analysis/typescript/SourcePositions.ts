import type {Node, SourceFile, ts} from 'ts-morph';
import type {SourceRange} from '../../Types.js';

/**
 * Line and column of a position — exactly what ts-morph's
 * `sourceFile.getLineAndColumnAtPos(pos)` returns, without its two scans of
 * the text per call (one from the file start counting newlines, one back to
 * the line start). Those scans made every range linear in the file length.
 *
 * ts-morph's definition is kept as is, quirks included:
 * - line: 1 + the number of `\n` before `pos` (a lone `\r` starts no line);
 * - column: 1 + the distance from the last `\n` OR `\r` before `pos`.
 *
 * Both break lists are built once per file (keyed by the compiler
 * SourceFile, like the node index) and searched binarily.
 */
interface BreakTable {
    /** Positions of `\n`, ascending. */
    newlines: number[];
    /** Positions of `\n` or `\r`, ascending. */
    breaks: number[];
}

const tables = new WeakMap<ts.SourceFile, BreakTable>();

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;

const breakTable = (sourceFile: SourceFile): BreakTable => {
    const cached = tables.get(sourceFile.compilerNode);
    if (cached !== undefined) {
        return cached;
    }
    const text = sourceFile.getFullText();
    const newlines: number[] = [];
    const breaks: number[] = [];
    for (let at = 0; at < text.length; at += 1) {
        const code = text.charCodeAt(at);
        if (code === NEWLINE) {
            newlines.push(at);
            breaks.push(at);
        } else if (code === CARRIAGE_RETURN) {
            breaks.push(at);
        }
    }
    const table = {newlines, breaks};
    tables.set(sourceFile.compilerNode, table);
    return table;
};

/** How many of the ascending `positions` lie before `pos`. */
const countBefore = (positions: readonly number[], pos: number): number => {
    let low = 0;
    let high = positions.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if ((positions[middle] as number) < pos) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
};

/** Same result as `sourceFile.getLineAndColumnAtPos(pos)` for a position within the text. */
export const lineAndColumnAt = (sourceFile: SourceFile, pos: number): {line: number; column: number} => {
    const {newlines, breaks} = breakTable(sourceFile);
    const before = countBefore(breaks, pos);
    const lineStart = before === 0 ? 0 : (breaks[before - 1] as number) + 1;
    return {line: countBefore(newlines, pos) + 1, column: pos - lineStart + 1};
};

/** A node's range from its start (trivia excluded) to its end. */
export const rangeOfNode = (sourceFile: SourceFile, node: Node): SourceRange => {
    const start = lineAndColumnAt(sourceFile, node.getStart());
    const end = lineAndColumnAt(sourceFile, node.getEnd());
    return {startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column};
};

/**
 * How many lines a node spans — what `node.getEndLineNumber() -
 * node.getStartLineNumber() + 1` returns. ts-morph steps back to the line
 * start before counting `\n`; no `\n` lies between a line start and the
 * position, so the line of the position itself is the same number.
 */
export const lineSpanOf = (sourceFile: SourceFile, node: Node): number =>
    lineAndColumnAt(sourceFile, node.getEnd()).line - lineAndColumnAt(sourceFile, node.getStart()).line + 1;
