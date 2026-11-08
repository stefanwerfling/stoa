import type {Fact} from '../Types.js';
import {resolveEntryPoints, type EntryDeclarations} from '../config/EntryPoints.js';

/**
 * `module.isPackageEntry`: a project-derived fact on a file that is a package
 * entry point — declared in `entryPoints` (stoa.config.json) or named by the
 * root package.json (`main`, `module`, `types`, `exports`, `bin`), resolved
 * as for R-UNUSED-EXPORT (config/EntryPoints.ts). Such a file's exports are
 * the package's public API: it is as wide as the package, by design, and the
 * narrow re-exporting entry R-WIDE-PUBLIC-SURFACE itself recommends. The
 * fact joins the file's `metric.exportCount` unit (same subject); the rule
 * engine derives it only for a rule set that references it.
 */
export const PACKAGE_ENTRY = 'module.isPackageEntry';

export const packageEntryFacts = (facts: readonly Fact[], entries: EntryDeclarations, analyzedFiles: ReadonlySet<string>): Fact[] => {
    const entryFiles = resolveEntryPoints(entries, analyzedFiles);
    if (entryFiles.size === 0) {
        return [];
    }
    return facts
        .filter((fact) => fact.kind === 'metric.exportCount' && entryFiles.has(fact.subject.file))
        .map((fact) => ({
            id: `${fact.id}:${PACKAGE_ENTRY}`,
            kind: PACKAGE_ENTRY,
            subject: fact.subject,
            value: true,
            evidence: [],
            certainty: 'syntactic',
            producedBy: {adapter: 'entry-points', version: '1'}
        }));
};
