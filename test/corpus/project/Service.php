<?php

function parseFile(): array
{
    return [];
}

// Positive: the catch swallows the error (returns a default, no log/handle/rethrow).
function loadConfig(): array
{
    try {
        return parseFile();
    } catch (\Throwable $e) {
        return [];
    }
}

// Positive: tangled control flow — same shape as the TypeScript positive.
function phpTangled(int $a, int $b): int
{
    $r = 0;
    if ($a > 0) {
        for ($i = 0; $i < $b; $i++) {
            if ($i % 2 === 0) {
                if ($a > $i && $b > $i) {
                    $r += 1;
                }
            }
        }
    }
    if ($b > 0 && $a > 0) {
        while ($r > 0) {
            $r -= 1;
        }
    }
    if ($a < 0 || $b < 0) {
        $r = $r > 0 ? $r : -$r;
    }
    return $r;
}
