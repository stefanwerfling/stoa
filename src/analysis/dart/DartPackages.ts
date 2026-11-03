import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

/**
 * The Dart packages the analyzed files belong to: package name → its `lib/`
 * directory, read from the nearest `pubspec.yaml` above each analyzed `.dart`
 * file (its `name:` line). This is what turns `package:my_app/x.dart` into a
 * file of the analyzed set. Only the project's OWN packages are mapped — no
 * `.dart_tool/package_config.json`, no pub cache, no network: an import of
 * another package stays external (opaque). Read once per analysis, after
 * extraction (like the tsconfig for the ModuleGraph); never part of the
 * file-local FactCache.
 */
export type DartPackageMap = ReadonlyMap<string, string>;

const NAME_LINE = /^name:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*(#.*)?$/m;

export const loadDartPackages = (dartFiles: Iterable<string>): DartPackageMap => {
    const packages = new Map<string, string>();
    const seen = new Set<string>();
    for (const file of dartFiles) {
        let directory = dirname(file);
        for (;;) {
            if (seen.has(directory)) {
                break;
            }
            seen.add(directory);
            const pubspec = join(directory, 'pubspec.yaml');
            if (existsSync(pubspec)) {
                const name = readPackageName(pubspec);
                if (name !== null && !packages.has(name)) {
                    packages.set(name, join(directory, 'lib'));
                }
                break;
            }
            const parent = dirname(directory);
            if (parent === directory) {
                break;
            }
            directory = parent;
        }
    }
    return new Map([...packages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

const readPackageName = (pubspec: string): string | null => {
    try {
        return NAME_LINE.exec(readFileSync(pubspec, 'utf8'))?.[1] ?? null;
    } catch {
        // An unreadable pubspec maps nothing; its package's imports stay external.
        return null;
    }
};
