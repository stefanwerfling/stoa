<?php
// Negative: Schema-API up() with only safe column adds (nullable, or NOT NULL
// with a default, or an autoincrement id). The drop sits in down().
namespace App\Migrations;

final class Version20260104 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $table = $schema->createTable('safe');
        $table->addColumn('id', 'integer', ['autoincrement' => true]);
        $table->addColumn('note', 'string', ['notnull' => false]);
        $table->addColumn('score', 'integer', ['notnull' => true, 'default' => 0]);
    }

    public function down(Schema $schema): void
    {
        $schema->dropTable('safe');
    }
}
