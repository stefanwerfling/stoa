// Positive: a migration using the TypeORM query builder without existence
// guards. The createTable(..., true) call is guarded and must not be flagged.
export class CreateThings1700000000001 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(new Table({name: 'things'}));
        await queryRunner.createTable(new Table({name: 'safe'}), true);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('things');
    }
}
