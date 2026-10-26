<?php
// Positive: an eager ManyToOne. The entity has a primary key (so no no-PK
// finding) and a LAZY relation that must not be flagged.
namespace App\Entity;

#[ORM\Entity]
class Order
{
    #[ORM\Id]
    #[ORM\Column]
    private int $id;

    #[ORM\ManyToOne(targetEntity: Customer::class, fetch: 'EAGER')]
    private $customer;

    #[ORM\OneToMany(targetEntity: Line::class, mappedBy: 'order', fetch: 'LAZY')]
    private $lines;
}
