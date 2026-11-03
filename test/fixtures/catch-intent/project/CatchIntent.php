<?php

function risky(): int { return 1; }

// Negative: comment-only catch documents the deliberate ignore.
function documented(): void
{
    try {
        risky();
    } catch (\Exception $e) {
        // best effort — the cache rebuilds on the next request
    }
}

// Negative: the error is kept for later.
function kept(): ?\Exception
{
    $last = null;
    try {
        risky();
    } catch (\Exception $e) {
        $last = $e;
    }
    return $last;
}

// Positive: default value, no comment, error never read.
function swallowed(): int
{
    try {
        return risky();
    } catch (\Exception $e) {
        return 0;
    }
}
