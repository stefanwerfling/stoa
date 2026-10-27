<?php
// Positive: annotation relation with the constant fetch form
// (fetch=ClassMetadataInfo::FETCH_EAGER) rather than the "EAGER" string.
namespace App\Entity;

/**
 * @ORM\Entity
 */
class Edge
{
    /**
     * @ORM\Id
     * @ORM\Column(type="integer")
     */
    private $id;

    /**
     * @ORM\ManyToOne(targetEntity="Vertex", fetch=ClassMetadataInfo::FETCH_EAGER)
     */
    private $source;
}
