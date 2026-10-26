// Positive: eager relations. Options as the 2nd argument (Order.tags) and as
// the 3rd argument after the inverse-side function (Thread.messages) must both
// be caught; eager:false is not flagged. Each entity has a primary key so the
// no-primary-key rule stays out of the way.
@Entity()
export class Order {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToMany(() => Tag, {eager: true})
    tags: Tag[];

    @ManyToOne(() => Customer, {eager: false})
    customer: Customer;
}

@Entity()
export class Thread {
    @PrimaryGeneratedColumn()
    id: number;

    @OneToMany(() => Message, (message) => message.thread, {eager: true})
    messages: Message[];
}
