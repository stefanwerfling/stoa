<?php
// Positive: attribute relation with the constant fetch form
// (fetch: ClassMetadataInfo::FETCH_EAGER) rather than the 'EAGER' string.
namespace App\Entity;

#[ORM\Entity]
class Node
{
    #[ORM\Id]
    #[ORM\Column]
    private int $id;

    #[ORM\ManyToOne(targetEntity: Parent::class, fetch: ClassMetadataInfo::FETCH_EAGER)]
    private $parent;
}
