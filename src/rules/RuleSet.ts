import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Rule} from './RuleTypes.js';

/**
 * A versioned set of declarative rules, loaded from one JSON file per rule and
 * ordered by filename for deterministic evaluation. See docs rule-model §6.
 */
export class RuleSet {
    private constructor(
        public readonly id: string,
        private readonly rules: Rule[]
    ) {}

    public static loadFromDirectory(dir: string, id: string): RuleSet {
        const files = readdirSync(dir)
            .filter((name) => name.endsWith('.json'))
            .sort();
        const rules = files.map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Rule);
        return new RuleSet(id, rules);
    }

    public all(): Rule[] {
        return [...this.rules];
    }

    public size(): number {
        return this.rules.length;
    }
}
