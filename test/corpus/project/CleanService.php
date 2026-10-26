<?php

function risky2(): void {}

// Negative: rethrows — not swallowed.
function safe(): void
{
    try {
        risky2();
    } catch (\Throwable $e) {
        throw $e;
    }
}
