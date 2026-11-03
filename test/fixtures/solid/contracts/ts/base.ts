export class Store {
    save(value: string): void {
        console.log(value);
    }

    load(): string {
        return '';
    }
}

export interface Handler {
    a(): void;
    b(): void;
    c(): void;
}

export abstract class Job {
    abstract run(): void;

    stop(): void {}
}
