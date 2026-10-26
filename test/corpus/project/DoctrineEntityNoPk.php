<?php
// Positive: a Doctrine entity with only plain columns and no #[ORM\Id].
namespace App\Entity;

#[ORM\Entity]
class Session
{
    #[ORM\Column]
    private string $token;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;
}
