<?php

use App\Unused\Helper;
use App\Used\Mailer;
use App\Internal\Secret;

function makeId(Mailer $mailer, Secret $secret): string
{
    return (string) rand();
}
