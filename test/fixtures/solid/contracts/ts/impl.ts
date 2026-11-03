import {Store, type Handler, Job} from './base';
import {Remote} from 'remote-lib';

// LSP: overrides a concrete method and only throws
export class ReadOnlyStore extends Store {
    override save(): void {
        throw new Error('Not supported');
    }
}

// abstract base member: not LSP; concrete stop: LSP
export class Once extends Job {
    run(): void {
        throw new Error('not implemented');
    }

    stop(): void {
        throw new Error('unsupported');
    }
}

// ISP: two of three interface members empty
export class Some implements Handler {
    a(): void {}

    b(): void {}

    c(): void {
        console.log('c');
    }
}

// only one empty: no finding
export class Most implements Handler {
    a(): void {}

    b(): void {
        console.log('b');
    }

    c(): void {
        console.log('c');
    }
}

// a fake is excluded by name
export class FakeStore extends Store {
    save(): void {
        throw new Error('not implemented');
    }
}

// an external base: unknown
export class Local extends Remote {
    save(): void {
        throw new Error('not implemented');
    }
}
