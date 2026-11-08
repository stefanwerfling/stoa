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

// Negative: a PHP catch variable outlives the catch — the retry loop keeps
// the last error and throws it after the final attempt (symfony QuestionHelper).
function retried(): int
{
    $attempts = 3;
    while ($attempts--) {
        try {
            return risky();
        } catch (\Exception $error) {
        }
    }
    throw $error;
}

// Positive: a later variable of the same name in another function is not a read.
function swallowedAgain(): int
{
    try {
        return risky();
    } catch (\Exception $error) {
        return 0;
    }
}
