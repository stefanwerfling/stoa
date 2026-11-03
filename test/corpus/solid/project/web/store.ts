export class Store {
    save(value: string): void {
        console.log(value);
    }
}

// LSP: overrides a concrete method and only throws
export class ReadOnlyStore extends Store {
    override save(): void {
        throw new Error('Not supported');
    }
}

export interface Handler {
    a(): void;
    b(): void;
    c(): void;
}

// ISP: two of three interface members empty
export class Some implements Handler {
    a(): void {}

    b(): void {}

    c(): void {
        console.log('c');
    }
}
