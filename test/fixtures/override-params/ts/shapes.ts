import {External} from 'some-package';

export class Base {
    // reported: the parent declares the long signature
    draw(a: number, b: number, c: number, d: number, e: number): void {}
}

export class Child extends Base {
    // not reported: overrides Base.draw
    draw(a: number, b: number, c: number, d: number, e: number): void {}
}

export class Grandchild extends Child {
    // not reported: overrides transitively
    draw(a: number, b: number, c: number, d: number, e: number): void {}
}

export class Adapter extends External {
    // not reported: `override` marker, external parent
    override send(a: number, b: number, c: number, d: number, e: number): void {}

    // reported: external parent without a marker proves nothing
    receive(a: number, b: number, c: number, d: number, e: number): void {}
}
