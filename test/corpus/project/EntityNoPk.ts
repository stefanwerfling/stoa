// Positive: a TypeORM entity with only plain columns and no primary key.
@Entity()
export class Session {
    @Column()
    token: string;

    @Column()
    createdAt: Date;
}
