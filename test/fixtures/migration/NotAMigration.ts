// A plain module (not a MigrationInterface). An unguarded-DDL string here must
// NOT be flagged — the rule is scoped to migration files only.
export const createUsersSql = 'CREATE TABLE users (id INT)';
