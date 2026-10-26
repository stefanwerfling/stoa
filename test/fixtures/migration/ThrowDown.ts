// Negative: a down() that deliberately throws declares the migration
// irreversible. That is a conscious choice and must NOT be flagged.
export class Irreversible1700000000006 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE IF NOT EXISTS `x` (id INT)');
    }

    public async down(): Promise<void> {
        throw new Error('irreversible migration');
    }
}
