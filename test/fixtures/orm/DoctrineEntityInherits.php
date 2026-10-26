<?php
// Negative: an entity that extends a base class may inherit its key, so the
// no-primary-key rule does not fire.
namespace App\Entity;

#[ORM\Entity]
class Admin extends BaseUser
{
    #[ORM\Column]
    private string $role;
}
