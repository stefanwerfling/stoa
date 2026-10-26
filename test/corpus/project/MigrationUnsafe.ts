// Positive: a migration with unguarded CREATE/DROP TABLE DDL.
export class Init1700000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE `users` (id INT PRIMARY KEY)');
        await queryRunner.query('CREATE TABLE IF NOT EXISTS `logs` (id INT)');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE `users`');
    }
}
