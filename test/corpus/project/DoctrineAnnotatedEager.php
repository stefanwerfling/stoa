<?php
// Positive: annotation-mapped eager relation (fetch="EAGER"). The entity has an
// @ORM\Id, and a LAZY relation that must not be flagged.
namespace App\Entity;

/**
 * @ORM\Entity
 */
class Invoice
{
    /**
     * @ORM\Id
     * @ORM\Column(type="integer")
     */
    private $id;

    /**
     * @ORM\ManyToOne(targetEntity="Customer", fetch="EAGER")
     */
    private $customer;

    /**
     * @ORM\OneToMany(targetEntity="Line", mappedBy="invoice", fetch="LAZY")
     */
    private $lines;
}
