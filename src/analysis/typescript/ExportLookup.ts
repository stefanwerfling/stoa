import type {Node, SourceFile} from 'ts-morph';

/**
 * `isExported()` / `isDefaultExport()` of a top-level declaration, without
 * asking ts-morph where the keyword alone decides.
 *
 * Both ts-morph methods fall back to a symbol lookup when the declaration
 * lacks the keyword. In an ES module that lookup can only find an export made
 * WITHOUT the keyword — a local `export {x}` / `export {x as default}`, or an
 * `export default x` / `export = x` assignment — so a module without any of
 * those is answered by the keyword alone. A declaration file always asks
 * ts-morph: a `.d.ts` module without an export list exports every declaration
 * implicitly (the binder's export context), keyword or not. Any other file
 * still asks ts-morph, so the result is the same in every case
 * (test/ExportLookup.test.ts compares it with ts-morph declaration by
 * declaration).
 *
 * Measured and not adopted (2026-11-04): answering the remaining cases from
 * the syntax too. Exact, but without a measurable gain — the Program ts-morph
 * builds for it is cheap for one file without lib files.
 */
interface ExportLookup {
    isExported: (declaration: ExportableDeclaration) => boolean;
    isDefaultExport: (declaration: DefaultExportableDeclaration) => boolean;
}

type ExportableDeclaration = Node & {hasExportKeyword: () => boolean; isExported: () => boolean};
type DefaultExportableDeclaration = Node & {hasDefaultKeyword: () => boolean; isDefaultExport: () => boolean};

export const exportLookup = (sourceFile: SourceFile): ExportLookup => {
    const assignments = sourceFile.getExportAssignments();
    const declarations = sourceFile.getExportDeclarations();
    const localExportList = declarations.some((declaration) => !declaration.hasModuleSpecifier());
    const namedDefault = declarations.some((declaration) =>
        declaration.getNamedExports().some((specifier) => (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === 'default')
    );
    const declarationFile = sourceFile.compilerNode.isDeclarationFile;
    const exportedWithoutKeyword = declarationFile || localExportList || assignments.length > 0;
    const defaultWithoutKeyword = declarationFile || namedDefault || assignments.some((assignment) => !assignment.isExportEquals());
    return {
        isExported: (declaration) => declaration.hasExportKeyword() || (exportedWithoutKeyword && declaration.isExported()),
        isDefaultExport: (declaration) => declaration.hasDefaultKeyword() || (defaultWithoutKeyword && declaration.isDefaultExport())
    };
};
