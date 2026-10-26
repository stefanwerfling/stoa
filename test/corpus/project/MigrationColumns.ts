// Positive: column DDL without existence guards, both raw SQL and builder.
export class AlterThings1700000000002 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE `things` ADD COLUMN `note` VARCHAR(255)');
        await queryRunner.addColumn('things', new TableColumn({name: 'extra', type: 'int'}));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('things', 'note');
    }
}
