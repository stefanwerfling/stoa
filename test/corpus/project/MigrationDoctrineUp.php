<?php
// Positive: a Doctrine migration whose guarded up() steps still lose data and
// add a NOT NULL column with no default. Guards keep the unguarded-DDL rule out.
namespace App\Migrations;

final class Version20260101 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE user ADD COLUMN IF NOT EXISTS age INT NOT NULL');
        $this->addSql('DROP TABLE IF EXISTS legacy');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('CREATE TABLE IF NOT EXISTS legacy (id INT)');
    }
}
