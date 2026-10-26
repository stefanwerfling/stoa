<?php

use App\Service\Mailer;
use App\Repository\UserRepository;

function wire(Mailer $mailer, UserRepository $users): void
{
    $mailer->send($users);
}
