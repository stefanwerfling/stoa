import {Base as B} from './base';
import Def from './def';
import * as ns from './base';
import {Base as ViaBarrel} from './barrel';
import {Ext} from 'some-lib';

class Local {
    l(): void {}
}

export class S1 extends B {
    a(): void {}
}
export class S2 extends Def {}
export class S3 extends ns.Base {
    a(): void {}
}
export class S4 extends Ext {}
export class S5 extends Error {}
export class S6 extends Local {}
export class S7 extends ViaBarrel {}
