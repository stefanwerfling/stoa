<?php
// Positive: an unguarded CREATE TABLE and no down() at all.
namespace App\Migrations;

final class Version20260102 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE account (id INT NOT NULL DEFAULT 0)');
    }
}
