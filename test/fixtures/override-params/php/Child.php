<?php

namespace App;

use App\Base as Parent_;

final class Child extends Parent_ implements Sink
{
    // not reported: overrides Base::addArgument (no marker, case-insensitive name)
    public function ADDARGUMENT(string $name, ?int $mode, string $description, mixed $default, array $suggested): static
    {
        return $this;
    }

    // not reported: implements Sink::write
    public function write(string $a, string $b, string $c, string $d, string $e): void
    {
    }

    // not reported: #[\Override] marker (external parent)
    #[\Override]
    public function render(int $a, int $b, int $c, int $d, int $e): void
    {
    }

    // reported: declared nowhere above
    public function own(int $a, int $b, int $c, int $d, int $e): void
    {
    }
}
