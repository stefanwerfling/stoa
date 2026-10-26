// Positive: destructive steps on the forward path. Both drops are guarded (IF
// EXISTS / a hasColumn check), so the unguarded-DDL rule stays quiet — the
// guard prevents a crash, not the data loss, which is exactly this rule's point.
export class Cleanup1700000000007 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE IF EXISTS `legacy`');
        if (await queryRunner.hasColumn('users', 'obsolete')) {
            await queryRunner.dropColumn('users', 'obsolete');
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE IF NOT EXISTS `legacy` (id INT)');
    }
}
