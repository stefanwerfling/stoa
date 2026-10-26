// Negatives: each entity declares (or inherits) a primary key, so none is
// flagged by R-ORM-ENTITY-NO-PK.
@Entity()
export class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;
}

@Entity()
export class Audit {
    @Column({primary: true})
    key: string;
}

abstract class Base {
    @PrimaryGeneratedColumn()
    id: number;
}

@Entity()
export class Account extends Base {
    @Column()
    balance: number;
}
