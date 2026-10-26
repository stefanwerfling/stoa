// Negative: a NOT NULL column with a DEFAULT, a nullable column, and an
// addColumn with isNullable:true — none breaks existing rows, none flagged.
export class Fine1700000000009 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `score` INT NOT NULL DEFAULT 0');
        await queryRunner.query('ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `nickname` VARCHAR(50)');
        if (!(await queryRunner.hasColumn('users', 'bio'))) {
            await queryRunner.addColumn('users', new TableColumn({name: 'bio', type: 'text', isNullable: true}));
        }
    }

    public async down(): Promise<void> {
        throw new Error('irreversible');
    }
}
