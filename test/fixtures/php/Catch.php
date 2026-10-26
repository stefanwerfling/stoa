<?php

function risky(): void {}

function emptyCatch(): void
{
    try {
        risky();
    } catch (\Exception $e) {
    }
}

function rethrowCatch(): void
{
    try {
        risky();
    } catch (\Exception $e) {
        throw $e;
    }
}

function swallowCatch(): int
{
    try {
        risky();
        return 1;
    } catch (\Exception $e) {
        return 0;
    }
}
