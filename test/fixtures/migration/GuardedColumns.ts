// Negative: a hasColumn() check in the same method guards the change, so the
// addColumn call must NOT be flagged.
export class Guarded1700000000003 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('things', 'extra'))) {
            await queryRunner.addColumn('things', new TableColumn({name: 'extra', type: 'int'}));
        }
    }
}
