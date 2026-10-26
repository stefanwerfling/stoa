import type {FileRef, LanguageAdapter} from './LanguageAdapter.js';

/**
 * Holds the registered language adapters and resolves the first one that
 * supports a given file. Registration order therefore defines precedence.
 */
export class AdapterRegistry {
    private readonly adapters: LanguageAdapter[] = [];

    public register(adapter: LanguageAdapter): this {
        this.adapters.push(adapter);
        return this;
    }

    public resolve(file: FileRef): LanguageAdapter | null {
        return this.adapters.find((adapter) => adapter.supports(file)) ?? null;
    }

    public versions(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const adapter of this.adapters) {
            result[adapter.id] = adapter.version;
        }
        return result;
    }
}
