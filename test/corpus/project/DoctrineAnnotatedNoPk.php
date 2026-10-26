<?php
// Positive: annotation-mapped Doctrine entity (docblock @ORM\Entity) with no
// @ORM\Id — the older style before PHP 8 attributes.
namespace App\Entity;

/**
 * @ORM\Entity
 */
class Account
{
    /**
     * @ORM\Column(type="string")
     */
    private $token;
}
