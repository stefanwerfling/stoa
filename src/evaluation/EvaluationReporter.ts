import type {EvaluationResult, FindingKey} from './EvaluationTypes.js';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const keyLine = (key: FindingKey): string => `  - ${key.file} · ${key.rule} · ${key.symbol}`;

/** Renders an evaluation result as a human-readable Markdown report. */
export const toMarkdown = (result: EvaluationResult): string => {
    const lines: string[] = [];
    const {overall} = result;
    lines.push('# stoa – Evaluation');
    lines.push('');
    lines.push(
        `- Overall: precision ${pct(overall.precision)} · recall ${pct(overall.recall)} ` +
            `(TP ${overall.truePositives} / FP ${overall.falsePositives} / FN ${overall.falseNegatives}; ` +
            `${overall.producedCount} produced)`
    );
    lines.push('');
    lines.push('## Per rule');
    lines.push('');
    lines.push('| rule | TP | FP | FN | precision | recall |');
    lines.push('|------|----|----|----|-----------|--------|');
    for (const rule of result.perRule) {
        lines.push(
            `| ${rule.rule} | ${rule.truePositives} | ${rule.falsePositives} | ${rule.falseNegatives} | ` +
                `${pct(rule.precision)} | ${pct(rule.recall)} |`
        );
    }

    if (result.byLanguage.length > 0) {
        lines.push('');
        lines.push('## Per language');
        lines.push('');
        lines.push('| language | expected | produced | TP | FP | FN | precision | recall |');
        lines.push('|----------|----------|----------|----|----|----|-----------|--------|');
        for (const language of result.byLanguage) {
            lines.push(
                `| ${language.language} | ${language.expected} | ${language.produced} | ${language.truePositives} | ` +
                    `${language.falsePositives} | ${language.falseNegatives} | ${pct(language.precision)} | ${pct(language.recall)} |`
            );
        }
    }

    if (result.falsePositives.length > 0) {
        lines.push('');
        lines.push('## False positives');
        result.falsePositives.forEach((key) => lines.push(keyLine(key)));
    }
    if (result.falseNegatives.length > 0) {
        lines.push('');
        lines.push('## False negatives');
        result.falseNegatives.forEach((key) => lines.push(keyLine(key)));
    }
    if (result.duplicates.length > 0) {
        lines.push('');
        lines.push('## Duplicate findings (same identity key)');
        result.duplicates.forEach((key) => lines.push(keyLine(key)));
    }
    if (result.duplicateExpected.length > 0) {
        lines.push('');
        lines.push('## Duplicate expected entries (corpus error)');
        result.duplicateExpected.forEach((key) => lines.push(keyLine(key)));
    }
    return lines.join('\n');
};
