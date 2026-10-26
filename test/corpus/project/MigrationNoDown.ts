// Positive: migrations that cannot be rolled back. The guarded CREATE keeps
// these files free of unguarded-DDL findings, isolating the no-down concern.
export class AddThing1700000000004 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE IF NOT EXISTS `thing` (id INT)');
    }
}

export class EmptyDown1700000000005 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE IF NOT EXISTS `other` (id INT)');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {}
}
