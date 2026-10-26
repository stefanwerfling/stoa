// Positive: NOT NULL columns added in up() with no default. Both adds are
// existence-guarded, so the unguarded-DDL rule stays quiet and only the
// nullable-no-default concern remains.
export class AddColumns1700000000008 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `age` INT NOT NULL');
        if (!(await queryRunner.hasColumn('users', 'role'))) {
            await queryRunner.addColumn('users', new TableColumn({name: 'role', type: 'varchar', isNullable: false}));
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE `users` DROP COLUMN IF EXISTS `age`');
    }
}
