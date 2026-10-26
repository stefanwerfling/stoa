import {readFileSync} from 'node:fs';
import type {Foo} from './Foo.js';

export const read = readFileSync;
export type Bar = Foo;
