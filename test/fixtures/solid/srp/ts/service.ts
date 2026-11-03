import {readFileSync} from 'node:fs';
import {Mailer} from './mailer.js';
import {Store} from './store.js';

export class UserService {
    private readonly store = new Store();
    private readonly mailer = new Mailer();

    public save(key: string): void {
        this.store.put(key);
    }

    public notify(to: string): void {
        this.mailer.send(to);
        this.mailer.send(readFileSync(to, 'utf8'));
    }
}

export class Together {
    private readonly store = new Store();
    private readonly mailer = new Mailer();

    public saveAndNotify(key: string): void {
        this.store.put(key);
        this.mailer.send(key);
    }
}
