import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Principle} from '../Types.js';
import {assertValidPrinciple} from './KnowledgeValidation.js';

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
        const sourceFile = new Map<string, string>();
        for (const file of files) {
            const raw = readFileSync(join(principlesDir, file), 'utf8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                throw new Error(`knowledge: ${file} is not valid JSON: ${(error as Error).message}`);
            }
            const principle = assertValidPrinciple(parsed, file);
            const existing = sourceFile.get(principle.id);
            if (existing !== undefined) {
                throw new Error(`knowledge: duplicate principle id "${principle.id}" in ${file} (already defined in ${existing})`);
            }
            principles.set(principle.id, principle);
            sourceFile.set(principle.id, file);
        }

        // Reference integrity: relatedPrinciples must point at principles that
        // actually exist in this base (a dangling id is a knowledge-base error).
        for (const principle of principles.values()) {
            for (const related of principle.relatedPrinciples ?? []) {
                if (!principles.has(related)) {
                    throw new Error(`knowledge: principle "${principle.id}" (${sourceFile.get(principle.id) ?? '?'}) references unknown related principle "${related}"`);
                }
            }
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
