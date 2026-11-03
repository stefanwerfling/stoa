import {Http} from './http';
import * as db from './db';
import Logger from './logger';

export interface Store extends db.Base, Other<number> {
    name: string;
    load(id: string): Promise<Item | null>;
}

export abstract class Repo extends db.Base implements Store {
    static instance = new Repo2();
    name = '';
    private readonly cache: Map<string, Item> = new Map();

    constructor(private readonly http: Http, public log?: Logger) {
        super();
    }

    abstract load(id: string): Promise<Item | null>;

    override save(item: Item): void {
        this.cache.set(item.id, item);
        db.write(this.name, item);
        const conn = new db.Connection();
        Logger.level;
    }

    get size(): number {
        return this.cache.size;
    }

    remove(): void {
        throw new Error('Not implemented');
    }

    fail(): void {
        throw new Error('boom');
    }

    clear(): void {}
}
