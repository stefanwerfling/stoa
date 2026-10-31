import type {QualityDimension} from '../Types.js';

/** Either a single string (used for every language) or a per-language map. */
export type LocalizedText = string | Record<string, string>;

export const DEFAULT_LANG = 'en';

/**
 * Resolves a localized value for a language, falling back to the default
 * language and then to any available entry. A plain string resolves as-is, so
 * untranslated data keeps working.
 */
export const localize = (text: LocalizedText, lang: string): string => {
    if (typeof text === 'string') {
        return text;
    }
    return text[lang] ?? text[DEFAULT_LANG] ?? Object.values(text)[0] ?? '';
};

export interface ReportLabels {
    title: string;
    engine: string;
    ruleSet: string;
    knowledgeBase: string;
    files: string;
    facts: string;
    noFindings: string;
    findings: string;
    observation: string;
    severity: string;
    confidence: string;
    dimensions: string;
    interpretation: string;
    suggestion: string;
    drawbacks: string;
    llm: string;
    baseline: string;
    baselineNew: string;
    baselineKnown: string;
    baselineFixed: string;
}

const LABELS: Record<string, ReportLabels> = {
    en: {
        title: 'stoa – Analysis Report',
        engine: 'Engine',
        ruleSet: 'Rule set',
        knowledgeBase: 'Knowledge base',
        files: 'Files selected/analyzed/skipped',
        facts: 'Facts extracted',
        noFindings: 'No findings.',
        findings: 'Findings',
        observation: 'Observation',
        severity: 'Severity',
        confidence: 'Confidence',
        dimensions: 'Dimensions',
        interpretation: 'Possible interpretation (not a fact)',
        suggestion: 'Suggestion',
        drawbacks: 'Drawbacks',
        llm: 'LLM assessment (advisory — not a fact)',
        baseline: 'Baseline',
        baselineNew: 'new',
        baselineKnown: 'known',
        baselineFixed: 'fixed'
    },
    de: {
        title: 'stoa – Analysebericht',
        engine: 'Engine',
        ruleSet: 'Regelsatz',
        knowledgeBase: 'Wissensbasis',
        files: 'Dateien ausgewählt/analysiert/übersprungen',
        facts: 'Extrahierte Facts',
        noFindings: 'Keine Befunde.',
        findings: 'Befunde',
        observation: 'Beobachtung',
        severity: 'Schwere',
        confidence: 'Konfidenz',
        dimensions: 'Dimensionen',
        interpretation: 'Mögliche Deutung (keine Tatsache)',
        suggestion: 'Vorschlag',
        drawbacks: 'Nachteile',
        llm: 'LLM-Einschätzung (beratend – keine Tatsache)',
        baseline: 'Baseline',
        baselineNew: 'neu',
        baselineKnown: 'bekannt',
        baselineFixed: 'behoben'
    }
};

export const labelsFor = (lang: string): ReportLabels => LABELS[lang] ?? LABELS[DEFAULT_LANG]!;

const DIMENSION_LABELS: Record<string, Record<QualityDimension, string>> = {
    de: {
        complexity: 'Komplexität',
        understandability: 'Verständlichkeit',
        'responsibility-boundaries': 'Verantwortungsgrenzen',
        dependencies: 'Abhängigkeiten',
        'error-handling': 'Fehlerbehandlung',
        'side-effect-control': 'Seiteneffekt-Kontrolle',
        'decision-evidence': 'Belegbarkeit',
        robustness: 'Robustheit',
        accessibility: 'Barrierefreiheit',
        usability: 'Bedienbarkeit'
    }
};

export const dimensionLabel = (dimension: QualityDimension, lang: string): string => {
    return DIMENSION_LABELS[lang]?.[dimension] ?? dimension;
};
