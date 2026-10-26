import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Principle} from '../Types.js';

/**
 * The philosophical knowledge base. It is read-only for the rule and semantic
 * layers and carries no execution logic (see docs architecture §B). Principles
 * are loaded from one JSON file each so they stay zitierfähig and versioned.
 */
export class KnowledgeBase {
    private constructor(
        public readonly id: string,
        private readonly principles: Map<string, Principle>
    ) {}

    public static loadFromDirectory(dir: string, id: string): KnowledgeBase {
        const principlesDir = join(dir, 'principles');
        const files = readdirSync(principlesDir)
            .filter((name) => name.endsWith('.json'))
            .sort();

        const principles = new Map<string, Principle>();
        for (const file of files) {
            const raw = readFileSync(join(principlesDir, file), 'utf8');
            const principle = JSON.parse(raw) as Principle;
            principles.set(principle.id, principle);
        }
        return new KnowledgeBase(id, principles);
    }

    public get(id: string): Principle | null {
        return this.principles.get(id) ?? null;
    }

    public all(): Principle[] {
        return [...this.principles.values()];
    }

    public size(): number {
        return this.principles.size;
    }
}
