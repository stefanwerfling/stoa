/**
 * Language-neutral analysis of raw migration SQL. These helpers take a SQL
 * string (from a TypeORM queryRunner.query() literal or a Doctrine addSql()
 * argument) and return a short descriptor when it matches a known risk, or null.
 * Keeping them here lets the TypeScript and PHP adapters feed the same
 * migration rules from the same checks.
 */

const CREATE_TABLE = /\bcreate\s+table\b/i;
const CREATE_TABLE_GUARDED = /\bcreate\s+table\s+if\s+not\s+exists\b/i;
const DROP_TABLE = /\bdrop\s+table\b/i;
const DROP_TABLE_GUARDED = /\bdrop\s+table\s+if\s+exists\b/i;
const ADD_COLUMN = /\badd\s+column\b/i;
const ADD_COLUMN_GUARDED = /\badd\s+column\s+if\s+not\s+exists\b/i;
const DROP_COLUMN = /\bdrop\s+column\b/i;
const DROP_COLUMN_GUARDED = /\bdrop\s+column\s+if\s+exists\b/i;
const NOT_NULL = /\bnot\s+null\b/i;
const HAS_DEFAULT = /\bdefault\b/i;
const AUTO_FILLED = /\b(auto_increment|generated|serial)\b/i;

// DDL that assumes a table/column does (not) already exist, without an
// IF [NOT] EXISTS guard.
export const unguardedDdl = (sql: string): string | null => {
    if (CREATE_TABLE.test(sql) && !CREATE_TABLE_GUARDED.test(sql)) {
        return 'CREATE TABLE without IF NOT EXISTS';
    }
    if (DROP_TABLE.test(sql) && !DROP_TABLE_GUARDED.test(sql)) {
        return 'DROP TABLE without IF EXISTS';
    }
    if (ADD_COLUMN.test(sql) && !ADD_COLUMN_GUARDED.test(sql)) {
        return 'ADD COLUMN without IF NOT EXISTS';
    }
    if (DROP_COLUMN.test(sql) && !DROP_COLUMN_GUARDED.test(sql)) {
        return 'DROP COLUMN without IF EXISTS';
    }
    return null;
};

// Destructive DDL on the forward path — the drop itself loses data regardless
// of any existence guard.
export const destructiveDdl = (sql: string): string | null => {
    if (DROP_TABLE.test(sql)) {
        return 'DROP TABLE in up() destroys data';
    }
    if (DROP_COLUMN.test(sql)) {
        return 'DROP COLUMN in up() destroys data';
    }
    return null;
};

// A raw ADD COLUMN that is NOT NULL and has no DEFAULT (and is not auto-filled);
// it breaks against a table that already holds rows.
export const nullableNoDefault = (sql: string): string | null => {
    if (!ADD_COLUMN.test(sql) || !NOT_NULL.test(sql)) {
        return null;
    }
    if (HAS_DEFAULT.test(sql) || AUTO_FILLED.test(sql)) {
        return null;
    }
    return 'ADD COLUMN ... NOT NULL without DEFAULT';
};
