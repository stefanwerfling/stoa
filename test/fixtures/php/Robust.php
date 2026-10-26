<?php

use App\Unused\Helper;
use App\Used\Mailer;

function makeId(Mailer $mailer): string
{
    return (string) rand();
}
