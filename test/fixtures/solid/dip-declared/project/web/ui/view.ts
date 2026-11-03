import axios from 'axios';
import {client} from '@scope/net/client';
import {load} from '../data/api';
import type {Dto} from '../data/dto';

export const view = (dto: Dto): unknown => [axios, client, load(), dto];
