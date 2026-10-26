// Negative: relations without eager:true. A relation with only an inverse-side
// function and one with eager:false must not be flagged.
@Entity()
export class Post {
    @PrimaryGeneratedColumn()
    id: number;

    @OneToMany(() => Comment, (comment) => comment.post)
    comments: Comment[];

    @ManyToOne(() => Author, {eager: false})
    author: Author;
}
