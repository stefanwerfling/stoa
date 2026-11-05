/**
 * The headers of the C and C++ standard libraries (ISO C up to C23, ISO C++
 * up to C++23 including the C compatibility headers `<cxxx>`). An `#include
 * <x>` of one of these names is outside the project by definition — the
 * only system include Stoa classifies as external; any other `<…>` header
 * (POSIX, a platform SDK, a library, or the project itself via `-I`) stays
 * unknown.
 */
const C_HEADERS = [
    'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h', 'inttypes.h', 'iso646.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h', 'signal.h',
    'stdalign.h', 'stdarg.h', 'stdatomic.h', 'stdbit.h', 'stdbool.h', 'stdckdint.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h', 'string.h',
    'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h', 'wctype.h'
];

const CPP_HEADERS = [
    'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset', 'charconv', 'chrono', 'codecvt', 'compare', 'complex', 'concepts', 'condition_variable',
    'coroutine', 'deque', 'exception', 'execution', 'expected', 'filesystem', 'flat_map', 'flat_set', 'format', 'forward_list', 'fstream', 'functional', 'future',
    'generator', 'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch', 'limits', 'list', 'locale', 'map', 'mdspan',
    'memory', 'memory_resource', 'mutex', 'new', 'numbers', 'numeric', 'optional', 'ostream', 'print', 'queue', 'random', 'ranges', 'ratio', 'regex',
    'scoped_allocator', 'semaphore', 'set', 'shared_mutex', 'source_location', 'span', 'spanstream', 'sstream', 'stack', 'stacktrace', 'stdexcept', 'stdfloat',
    'stop_token', 'streambuf', 'string', 'string_view', 'strstream', 'syncstream', 'system_error', 'thread', 'tuple', 'type_traits', 'typeindex', 'typeinfo',
    'unordered_map', 'unordered_set', 'utility', 'valarray', 'variant', 'vector', 'version'
];

// `<cassert>` … — the C headers in C++ form (`<ciso646>`, `<cstdalign>` and friends included; removed or not, they name the standard library).
const CPP_C_HEADERS = C_HEADERS.map((header) => `c${header.slice(0, -'.h'.length)}`);

const STANDARD_HEADERS: ReadonlySet<string> = new Set([...C_HEADERS, ...CPP_HEADERS, ...CPP_C_HEADERS]);

/** Whether `<header>` names a header of the C or C++ standard library. */
export const isStandardHeader = (header: string): boolean => STANDARD_HEADERS.has(header);
