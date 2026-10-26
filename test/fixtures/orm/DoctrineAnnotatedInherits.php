<?php
// Negative: an annotation-mapped entity that extends a base may inherit its key,
// so the no-primary-key rule does not fire.
namespace App\Entity;

/**
 * @ORM\Entity
 */
class Manager extends BaseStaff
{
    /**
     * @ORM\Column(type="string")
     */
    private $title;
}
