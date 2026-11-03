import type {DartDirectiveValue} from './DartDeclarations.js';

/**
 * Data-access / I/O packages for the layer classification (Flutter quality
 * track E5a). Static and versioned like `FlutterCatalog`: a package outside
 * this list is never treated as data access — unknown stays unknown.
 *
 * `dart:io` is special: most Flutter imports of it only need `Platform`. It
 * counts as data access only when its `show` list names a file/socket/HTTP/
 * process type; with `show` of other names only it does not count; without
 * `show` (or with `hide`) it is recorded as UNDECIDED and does not count
 * either — the facts carry no usage of the imported names.
 */
export const DATA_ACCESS_CATALOG_VERSION = '1.0.0';

export const DATA_ACCESS_PACKAGES: ReadonlySet<string> = new Set([
    'cloud_firestore',
    'dio',
    'drift',
    'firebase_database',
    'firebase_storage',
    'graphql_flutter',
    'hive',
    'http',
    'isar',
    'shared_preferences',
    'sqflite',
    'supabase_flutter'
]);

/** `dart:io` names that mean file, socket, HTTP or process access. */
export const DART_IO_ACCESS_NAMES: ReadonlySet<string> = new Set([
    'Directory',
    'File',
    'FileSystemEntity',
    'HttpClient',
    'HttpServer',
    'Link',
    'Process',
    'RandomAccessFile',
    'RawDatagramSocket',
    'RawSocket',
    'SecureServerSocket',
    'SecureSocket',
    'ServerSocket',
    'Socket',
    'WebSocket'
]);

/** What one import directive means for data access. */
export type DataAccessVerdict = {package: string; status: 'data-access' | 'undecided'} | null;

/** The package a `package:` URI belongs to (`package:http/http.dart` → `http`), else null. */
export const packageOfUri = (uri: string): string | null => {
    if (!uri.startsWith('package:')) {
        return null;
    }
    const rest = uri.slice('package:'.length);
    const slash = rest.indexOf('/');
    return slash <= 0 ? null : rest.slice(0, slash);
};

/** Classifies one `import` directive (any other directive kind: null). */
export const dataAccessOf = (directive: DartDirectiveValue): DataAccessVerdict => {
    if (directive.kind !== 'import' || directive.uri === null) {
        return null;
    }
    if (directive.uri === 'dart:io') {
        if (directive.show.length > 0) {
            return directive.show.some((name) => DART_IO_ACCESS_NAMES.has(name)) ? {package: 'dart:io', status: 'data-access'} : null;
        }
        return {package: 'dart:io', status: 'undecided'};
    }
    const name = packageOfUri(directive.uri);
    return name !== null && DATA_ACCESS_PACKAGES.has(name) ? {package: name, status: 'data-access'} : null;
};

/**
 * State-holder base classes (E6a, user decision): a project module declaring
 * a class that extends or mixes in one of these is a state-management holder.
 * A UI depending on it is the intended state-management pattern, so the DIP
 * layer rule does not count such a module as a data-access target, even when
 * it persists data itself. Name → library URI prefixes that provide it.
 */
export const STATE_HOLDER_CATALOG_VERSION = '1.0.0';

export const STATE_HOLDER_BASES: ReadonlyMap<string, readonly string[]> = new Map([
    ['ChangeNotifier', ['package:flutter/']],
    ['ValueNotifier', ['package:flutter/']],
    ['GetxController', ['package:get/']],
    ['Cubit', ['package:bloc/', 'package:flutter_bloc/']],
    ['Bloc', ['package:bloc/', 'package:flutter_bloc/']],
    ['StateNotifier', ['package:state_notifier/', 'package:riverpod/', 'package:flutter_riverpod/', 'package:hooks_riverpod/']],
    ['Notifier', ['package:riverpod/', 'package:flutter_riverpod/', 'package:hooks_riverpod/']],
    ['AsyncNotifier', ['package:riverpod/', 'package:flutter_riverpod/', 'package:hooks_riverpod/']]
]);
