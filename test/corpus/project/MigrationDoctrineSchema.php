<?php
// Positive: a Doctrine migration using the DBAL Schema API (no addSql). The
// up() drops a table and adds a NOT NULL column with no default; the
// autoincrement id is not flagged.
namespace App\Migrations;

final class Version20260103 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $table = $schema->createTable('report');
        $table->addColumn('id', 'integer', ['autoincrement' => true]);
        $table->setPrimaryKey(['id']);
        $table->addColumn('title', 'string', ['notnull' => true]);
        $schema->dropTable('legacy_report');
    }

    public function down(Schema $schema): void
    {
        $schema->dropTable('report');
    }
}
