import {User, Person, Account, models} from './barrel.js';
import {Dup} from './conflict/index.js';
import {Nothing} from './cycle/a.js';
import {Thing, Other} from './ext.js';
import {Gone} from './missing.js';
import type {UserType} from './types.js';
import NoDefault from './models/index.js';

export class C1 extends User {}
export class C2 extends Person {}
export class C3 extends Account {}
export class C4 extends models.User {}
export class C5 extends Dup {}
export class C6 extends Thing {}
export class C7 extends Gone {}
export class C8 extends NoDefault {}
export class C9 extends Other {}
export const used: [UserType | null, typeof Nothing | null] = [null, null];
