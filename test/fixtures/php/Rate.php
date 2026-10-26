<?php

function rate(int $n): string
{
    if ($n > 10) {
        return 'high';
    }
    if ($n > 5) {
        return 'mid';
    }
    return 'low';
}
