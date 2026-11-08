<?php

namespace App;

interface Sink
{
    public function write(string $a, string $b, string $c, string $d, string $e): void;
}

class Base
{
    // reported: the parent declares the long signature
    public function addArgument(string $name, ?int $mode, string $description, mixed $default, array $suggested): static
    {
        return $this;
    }
}
