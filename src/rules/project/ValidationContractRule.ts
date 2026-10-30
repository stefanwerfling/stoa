import type {Fact, Finding, PrincipleInterpretationRef, QualityDimension, Severity} from '../../Types.js';
import {findContractRule, type ContractRule, type ValidationContract} from '../../contracts/ValidationContract.js';
import type {ResolvedConditions} from '../../analysis/typescript/ValidationAnnotations.js';
import type {EvidenceGraph} from '../../evidence/EvidenceGraph.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {KnowledgeBase} from '../../knowledge/KnowledgeBase.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';

interface AnnotationValue {
    id: string;
    idValid: boolean;
    resolved: boolean;
    conditions?: ResolvedConditions;
}

type RuleId =
    | 'R-VALIDATION-CONTRACT-INVALID-ID'
    | 'R-VALIDATION-CONTRACT-UNKNOWN-ID'
    | 'R-VALIDATION-CONTRACT-UNRESOLVED'
    | 'R-VALIDATION-CONTRACT-MISMATCH'
    | 'R-VALIDATION-CONTRACT-CONFLICT'
    | 'R-VALIDATION-CONTRACT-NOT-IMPLEMENTED'
    | 'R-VALIDATION-CONTRACT-UNUSED-VALIDATOR'
    | 'R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION'
    | 'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED'
    | 'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED'
    | 'R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED';

interface UsageValue {
    id: string;
    sinks?: string[];
}

interface DataflowValue {
    id: string;
    graph: EvidenceGraph;
}

interface RuleMeta {
    principleId: string;
    dimensions: QualityDimension[];
    severity: Severity;
    confidence: number;
    certaintyBasis: 'syntactic' | 'semantic-heuristic';
}

const META: Record<RuleId, RuleMeta> = {
    'R-VALIDATION-CONTRACT-INVALID-ID': {principleId: 'marcus.purpose', dimensions: ['robustness'], severity: 'medium', confidence: 0.9, certaintyBasis: 'syntactic'},
    'R-VALIDATION-CONTRACT-UNKNOWN-ID': {principleId: 'marcus.purpose', dimensions: ['robustness'], severity: 'medium', confidence: 0.8, certaintyBasis: 'syntactic'},
    'R-VALIDATION-CONTRACT-UNRESOLVED': {principleId: 'marcus.judgment', dimensions: ['robustness', 'decision-evidence'], severity: 'low', confidence: 0.3, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-MISMATCH': {principleId: 'marcus.judgment', dimensions: ['robustness'], severity: 'high', confidence: 0.7, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-CONFLICT': {principleId: 'marcus.judgment', dimensions: ['robustness'], severity: 'high', confidence: 0.6, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-NOT-IMPLEMENTED': {principleId: 'marcus.judgment', dimensions: ['robustness', 'decision-evidence'], severity: 'low', confidence: 0.3, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-UNUSED-VALIDATOR': {principleId: 'marcus.obstacle', dimensions: ['robustness'], severity: 'medium', confidence: 0.5, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION': {principleId: 'marcus.judgment', dimensions: ['robustness'], severity: 'high', confidence: 0.6, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED': {principleId: 'marcus.judgment', dimensions: ['robustness', 'decision-evidence'], severity: 'low', confidence: 0.3, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED': {principleId: 'marcus.judgment', dimensions: ['robustness', 'decision-evidence'], severity: 'low', confidence: 0.3, certaintyBasis: 'semantic-heuristic'},
    'R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED': {principleId: 'marcus.judgment', dimensions: ['robustness', 'decision-evidence'], severity: 'low', confidence: 0.3, certaintyBasis: 'semantic-heuristic'}
};

const TEXT: Record<RuleId, {statement: LocalizedText; suggestion: LocalizedText; drawbacks?: LocalizedText; missingContext: LocalizedText; rationale: LocalizedText}> = {
    'R-VALIDATION-CONTRACT-INVALID-ID': {
        statement: {
            en: 'The stoa:validation annotation "{value}" is not a well-formed Validation Trace ID.',
            de: 'Die stoa:validation-Annotation "{value}" ist keine wohlgeformte Validation Trace ID.'
        },
        suggestion: {
            en: 'Use the project\'s stable ID format (a prefix, segments, a 3-digit suffix — e.g. VC-ITEM-QUANTITY-001), matching the contract\'s id pattern.',
            de: 'Das stabile ID-Format des Projekts verwenden (Präfix, Segmente, 3-stelliges Suffix — z. B. VC-ITEM-QUANTITY-001), passend zum id-Muster des Vertrags.'
        },
        missingContext: {
            en: 'An annotation is an analysis hint, not a security mechanism: a malformed ID only breaks Stoa\'s ability to trace the rule, it does not affect runtime behaviour.',
            de: 'Eine Annotation ist ein Analysehinweis, kein Sicherheitsmechanismus: eine fehlerhafte ID bricht nur die Nachverfolgbarkeit für Stoa, nicht das Laufzeitverhalten.'
        },
        rationale: {
            en: 'A Validation Trace ID exists to connect a business rule across layers; an ID that does not meet the agreed format defeats that purpose before any comparison can even start (marcus.purpose).',
            de: 'Eine Validation Trace ID verbindet eine fachliche Regel über Schichten hinweg; eine ID, die das vereinbarte Format verfehlt, unterläuft diesen Zweck, bevor ein Abgleich überhaupt beginnen kann (marcus.purpose).'
        }
    },
    'R-VALIDATION-CONTRACT-UNKNOWN-ID': {
        statement: {
            en: 'The stoa:validation annotation references "{value}", which is not defined in the loaded contract.',
            de: 'Die stoa:validation-Annotation verweist auf "{value}", das im geladenen Vertrag nicht definiert ist.'
        },
        suggestion: {
            en: 'Add the missing entry to the validation contract, or correct the ID if it was meant to reference an existing rule.',
            de: 'Den fehlenden Eintrag im Validation Contract ergänzen, oder die ID korrigieren, falls eine bestehende Regel gemeint war.'
        },
        missingContext: {
            en: 'Only the ID\'s presence in the loaded contract is checked; a contract the project maintains elsewhere (a different file, an older version) is not consulted.',
            de: 'Geprüft wird nur, ob die ID im geladenen Vertrag vorhanden ist; ein anderswo gepflegter Vertrag (eine andere Datei, eine ältere Version) wird nicht herangezogen.'
        },
        rationale: {
            en: 'An annotation naming an ID the contract does not know cannot be resolved to a business rule, so neither a human nor Stoa can tell what it was meant to guarantee (marcus.purpose).',
            de: 'Eine Annotation, die eine dem Vertrag unbekannte ID nennt, lässt sich keiner fachlichen Regel zuordnen; weder ein Mensch noch Stoa können erkennen, was sie garantieren sollte (marcus.purpose).'
        }
    },
    'R-VALIDATION-CONTRACT-UNRESOLVED': {
        statement: {
            en: 'The construct annotated with "{value}" could not be analyzed (not a recognized scalar Zod chain) — its conditions cannot be verified against the contract.',
            de: 'Das mit "{value}" annotierte Konstrukt konnte nicht analysiert werden (keine erkannte skalare Zod-Kette) — die Bedingungen lassen sich nicht gegen den Vertrag prüfen.'
        },
        suggestion: {
            en: 'No code change is implied by this finding alone; if accurate verification matters here, consider a directly comparable scalar schema, or treat this as a reminder for manual review.',
            de: 'Dieser Befund allein verlangt keine Codeänderung; falls eine belastbare Prüfung hier wichtig ist, ein direkt vergleichbares skalares Schema erwägen oder dies als Hinweis für eine manuelle Durchsicht behandeln.'
        },
        missingContext: {
            en: 'Stoa only resolves a direct z.number()/z.string()/z.boolean() chain with a small set of recognized modifiers. Object/array schemas, a vts schema, a wrapped/derived schema, or any unrecognized chained call (.refine(), .transform(), .default(), …) are left unresolved rather than guessed at.',
            de: 'Stoa löst nur eine direkte z.number()/z.string()/z.boolean()-Kette mit einer kleinen Menge erkannter Modifikatoren auf. Objekt-/Array-Schemas, ein vts-Schema, ein abgeleitetes Schema oder ein unbekannter verketteter Aufruf (.refine(), .transform(), .default(), …) bleiben unaufgelöst, statt erraten zu werden.'
        },
        rationale: {
            en: 'Reporting "cannot verify" instead of silently passing — or silently failing — keeps the distinction between a proven match, a proven mismatch and genuine uncertainty honest (marcus.judgment).',
            de: '„Kann nicht verifiziert werden" statt stillschweigend durchzulassen — oder stillschweigend fehlschlagen zu lassen — zu melden, erhält die Unterscheidung zwischen bewiesener Übereinstimmung, bewiesener Abweichung und echter Unsicherheit ehrlich (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-MISMATCH': {
        statement: {
            en: 'The implementation annotated with its Validation Trace ID disagrees with the contract: {value}.',
            de: 'Die mit ihrer Validation Trace ID annotierte Implementierung weicht vom Vertrag ab: {value}.'
        },
        suggestion: {
            en: 'Align the implementation with the contract\'s declared conditions, or update the contract if the implementation reflects the now-correct business rule.',
            de: 'Die Implementierung an die im Vertrag erklärten Bedingungen anpassen, oder den Vertrag aktualisieren, falls die Implementierung die nun korrekte fachliche Regel widerspiegelt.'
        },
        missingContext: {
            en: 'Only the dimensions the contract actually declares (dataType, required, nullable, min, max, normalization) are compared; an omitted dimension is treated as "not specified by the contract", not as "must be absent".',
            de: 'Verglichen werden nur die vom Vertrag tatsächlich erklärten Dimensionen (dataType, required, nullable, min, max, normalization); eine fehlende Dimension gilt als „vom Vertrag nicht spezifiziert", nicht als „muss fehlen".'
        },
        rationale: {
            en: 'A business rule that the contract states one way and the code enforces another way is exactly the inconsistency this feature exists to surface (marcus.judgment).',
            de: 'Eine fachliche Regel, die der Vertrag so und der Code anders durchsetzt, ist genau die Inkonsistenz, für die dieses Feature geschaffen wurde (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-CONFLICT': {
        statement: {
            en: 'Multiple implementations share the Validation Trace ID "{value}" but enforce different conditions.',
            de: 'Mehrere Implementierungen teilen die Validation Trace ID "{value}", setzen aber unterschiedliche Bedingungen durch.'
        },
        suggestion: {
            en: 'Determine which implementation reflects the intended business rule and align the other(s) — or split them under distinct IDs if they are genuinely different rules.',
            de: 'Bestimmen, welche Implementierung die beabsichtigte fachliche Regel widerspiegelt, und die andere(n) anpassen — oder sie unter eigenen IDs trennen, falls es wirklich verschiedene Regeln sind.'
        },
        missingContext: {
            en: 'A shared ID across layers is not, by itself, proof that two checks are semantically identical; Stoa only reports that their statically extracted conditions differ, not which (if either) is correct. The layer each implementation sits in is not consulted.',
            de: 'Eine über Schichten geteilte ID ist allein kein Beweis, dass zwei Prüfungen fachlich identisch sind; Stoa meldet nur, dass ihre statisch extrahierten Bedingungen voneinander abweichen, nicht, welche (falls überhaupt) korrekt ist. Die Schicht jeder Implementierung wird nicht herangezogen.'
        },
        rationale: {
            en: 'A trace ID is meant to assert "this is the same business rule"; two differing implementations under one ID mean that assertion itself is currently false (marcus.judgment).',
            de: 'Eine Trace-ID soll behaupten „das ist dieselbe fachliche Regel"; zwei abweichende Implementierungen unter einer ID bedeuten, dass diese Behauptung derzeit falsch ist (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-NOT-IMPLEMENTED': {
        statement: {
            en: 'No stoa:validation annotation for "{value}" was found anywhere in the analyzed files.',
            de: 'Keine stoa:validation-Annotation für "{value}" wurde in den analysierten Dateien gefunden.'
        },
        suggestion: {
            en: 'If this business rule is implemented, annotate it so Stoa can verify it; if it genuinely is not implemented yet, this is a real gap to close.',
            de: 'Falls diese fachliche Regel implementiert ist, annotieren, damit Stoa sie prüfen kann; falls sie wirklich noch nicht implementiert ist, ist dies eine zu schließende Lücke.'
        },
        missingContext: {
            en: 'Absence of evidence is not evidence of absence: the implementation may exist unannotated, in a file outside the analyzed set, in a language this slice does not scan for annotations (TypeScript only), or behind a validator Stoa cannot statically recognize.',
            de: 'Fehlender Beleg ist kein Beleg für Fehlen: Die Implementierung kann unannotiert existieren, in einer Datei außerhalb des analysierten Umfangs liegen, in einer Sprache, die dieser Schnitt nicht auf Annotationen durchsucht (nur TypeScript), oder hinter einem Validator, den Stoa statisch nicht erkennt.'
        },
        rationale: {
            en: 'A contract entry nobody has connected to any code is, at minimum, untracked — surfacing it as a low-confidence prompt for a human to check is more honest than silence (marcus.judgment).',
            de: 'Ein Vertragseintrag, den niemand mit Code verbunden hat, ist mindestens unverfolgt — ihn als Hinweis mit niedriger Konfidenz für eine menschliche Prüfung zu melden, ist ehrlicher als Schweigen (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-UNUSED-VALIDATOR': {
        statement: {
            en: 'The validator annotated with "{value}" exists but is never invoked (no .parse()/.safeParse() call on it anywhere in this file).',
            de: 'Der mit "{value}" annotierte Validator existiert, wird aber nie aufgerufen (kein .parse()/.safeParse()-Aufruf im gesamten Datei-Umfang).'
        },
        suggestion: {
            en: 'Call the validator on the request data it is meant to check, and use its result — or remove it if the business rule is enforced elsewhere.',
            de: 'Den Validator auf die zu prüfenden Request-Daten anwenden und dessen Ergebnis verwenden — oder entfernen, falls die fachliche Regel anderswo durchgesetzt wird.'
        },
        missingContext: {
            en: 'Scoped to a single file: a schema exported and used only from another file (possibly outside the analyzed set) looks identical to a genuinely unused one from here. This is a heuristic risk signal, not proof the business rule is unenforced.',
            de: 'Auf eine einzelne Datei begrenzt: ein Schema, das exportiert und nur in einer anderen Datei (möglicherweise außerhalb des analysierten Umfangs) verwendet wird, sieht von hier aus identisch zu einem wirklich unbenutzten aus. Dies ist ein heuristisches Risiko-Signal, kein Beweis, dass die fachliche Regel unangewendet bleibt.'
        },
        rationale: {
            en: 'A check that exists but is never run leaves the obstacle it was meant to remove — unchecked input — standing; declaring an intention is not the same as carrying it out (marcus.obstacle).',
            de: 'Eine Prüfung, die existiert, aber nie läuft, lässt das Hindernis bestehen, das sie beseitigen sollte — ungeprüften Input; eine Absicht zu erklären ist nicht dasselbe wie sie umzusetzen (marcus.obstacle).'
        }
    },
    'R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION': {
        statement: {
            en: 'The validator for "{value}" is called with request data, but a raw copy of the payload still reaches persistence in the same function.',
            de: 'Der Validator für "{value}" wird mit Request-Daten aufgerufen, doch eine rohe Kopie der Payload erreicht in derselben Funktion weiterhin die Persistenz.'
        },
        suggestion: {
            en: 'Persist only the validated result, not a separately-held raw reference to the same request value.',
            de: 'Nur das validierte Ergebnis persistieren, nicht eine separat gehaltene rohe Referenz auf denselben Request-Wert.'
        },
        missingContext: {
            en: 'Scoped to one function: the raw-reaching-a-sink evidence reuses the same detection as R-VALIDATION-MASS-ASSIGNMENT (Object.assign / a persistence-verb call fed a whole raw request value). Whether the two values are the SAME logical field is not confirmed field-by-field — only that both a validator call and a raw sink coexist in one function.',
            de: 'Auf eine Funktion begrenzt: Der Beleg „roh erreicht eine Senke" nutzt dieselbe Erkennung wie R-VALIDATION-MASS-ASSIGNMENT (Object.assign / ein Persistenz-Verb-Aufruf mit einem ganzen rohen Request-Wert). Ob beide Werte dasselbe fachliche Feld sind, wird nicht feldweise bestätigt — nur, dass in einer Funktion sowohl ein Validator-Aufruf als auch eine rohe Senke vorkommen.'
        },
        rationale: {
            en: 'Running a check and then saving data the check never touched achieves nothing: the judgment exercised on one path must actually gate what the other path persists (marcus.judgment).',
            de: 'Eine Prüfung laufen zu lassen und dann Daten zu speichern, die die Prüfung nie berührt hat, bewirkt nichts: Das auf einem Pfad ausgeübte Urteil muss tatsächlich bestimmen, was der andere Pfad persistiert (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED': {
        statement: {
            en: 'The validated result for "{value}" is passed onward, but where it ultimately goes could not be traced.',
            de: 'Das validierte Ergebnis für "{value}" wird weitergegeben, doch wohin es letztlich führt, ließ sich nicht nachverfolgen.'
        },
        suggestion: {
            en: 'No code change is implied by this finding alone; if proving this path matters here, consider keeping the call this validated value reaches inside the analyzed file, or treat this as a reminder for manual review.',
            de: 'Dieser Befund allein verlangt keine Codeänderung; falls der Nachweis dieses Pfads hier wichtig ist, den Aufruf, den dieser validierte Wert erreicht, innerhalb der analysierten Datei halten oder dies als Hinweis für eine manuelle Durchsicht behandeln.'
        },
        missingContext: {
            en: 'Stoa only follows ONE hop beyond the validating function, and only to a function/method declared in the SAME file. The callee here is named like a business/persistence layer (service/repository/…) but its implementation is an import, a dynamic/computed call, or an interface with no single resolvable implementation — so whether the validated value is actually persisted, transformed or discarded beyond this point is unproven, not disproven.',
            de: 'Stoa folgt nur EINEM Schritt über die validierende Funktion hinaus, und nur zu einer Funktion/Methode, die in DERSELBEN Datei deklariert ist. Der hier aufgerufene Name klingt nach einer Business-/Persistenzschicht (service/repository/…), doch seine Implementierung ist ein Import, ein dynamischer/berechneter Aufruf oder ein Interface ohne eindeutig auflösbare Implementierung — ob der validierte Wert ab hier tatsächlich persistiert, umgeformt oder verworfen wird, ist damit unbewiesen, nicht widerlegt.'
        },
        rationale: {
            en: 'Claiming a verified dataflow chain beyond what was actually traced would be a false certainty; stating plainly "this is where Stoa\'s trace ends" keeps proven relationships, heuristics and genuine unknowns honestly separate (marcus.judgment).',
            de: 'Eine über das tatsächlich Nachverfolgte hinausgehende, verifizierte Datenflusskette zu behaupten wäre eine falsche Sicherheit; klar zu sagen „hier endet Stoas Nachverfolgung" hält bewiesene Beziehungen, Heuristiken und echte Unbekannte ehrlich getrennt (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED': {
        statement: {
            en: 'The contract declares "{value}" applies to the backend layer, but no implementation could be attributed to the backend.',
            de: 'Der Vertrag erklärt, dass „{value}" für die Backend-Schicht gilt, doch keine Implementierung ließ sich dem Backend zuordnen.'
        },
        suggestion: {
            en: 'If this rule is meant to run on the server, make sure the annotated schema is actually invoked on request-handling data (e.g. req.body) somewhere; if it only runs on the frontend, remove "backend" from this rule\'s layers.',
            de: 'Falls diese Regel auf dem Server laufen soll, sicherstellen, dass das annotierte Schema tatsächlich auf Request-Daten (z. B. req.body) angewendet wird; falls sie nur im Frontend läuft, „backend" aus den layers dieser Regel entfernen.'
        },
        missingContext: {
            en: 'The contract\'s "layers" field is a claim, not proof — Stoa only confirms backend attribution when it can trace the annotated schema\'s invocation to request-handling data (the same evidence behind the Validator Dataflow Analysis). A schema annotated and resolvable, but never shown to touch a request, looks identical to one that genuinely only runs elsewhere.',
            de: 'Das Feld „layers" des Vertrags ist eine Behauptung, kein Beweis — Stoa bestätigt eine Backend-Zuordnung nur, wenn sich der Aufruf des annotierten Schemas bis zu Request-Daten zurückverfolgen lässt (derselbe Beleg wie bei der Validator-Datenflussanalyse). Ein annotiertes, auflösbares Schema, das nie nachweislich einen Request berührt, sieht identisch aus wie eines, das wirklich nur anderswo läuft.'
        },
        rationale: {
            en: 'A business rule claimed for the backend — the authoritative security boundary — but never actually observed running there is a gap worth surfacing, not a detail to take on faith (marcus.judgment).',
            de: 'Eine für das Backend — die autoritative Sicherheitsgrenze — behauptete fachliche Regel, die dort nie tatsächlich beobachtet läuft, ist eine Lücke, die es zu melden gilt, kein Detail, das man auf Treu und Glauben hinnimmt (marcus.judgment).'
        }
    },
    'R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED': {
        statement: {
            en: 'The contract requires server-side validation for "{value}", but no implementation could be attributed to the backend.',
            de: 'Der Vertrag verlangt für „{value}" eine serverseitige Validierung, doch keine Implementierung ließ sich dem Backend zuordnen.'
        },
        suggestion: {
            en: 'Make sure the annotated schema is actually invoked on request-handling data (e.g. req.body) on the server — a frontend-only check does not satisfy this requirement; the backend remains the authoritative security boundary.',
            de: 'Sicherstellen, dass das annotierte Schema tatsächlich auf Request-Daten (z. B. req.body) auf dem Server angewendet wird — eine reine Frontend-Prüfung erfüllt diese Anforderung nicht; das Backend bleibt die autoritative Sicherheitsgrenze.'
        },
        missingContext: {
            en: 'Of the six structured `security` flags a contract rule can declare, only `serverSideValidation` has a real static signal — the same backend-attribution evidence as the `layers` check above. The other five (authenticationRequired, authorizationRequired, ownershipRequired, tenantIsolation, massAssignmentProtection) are accepted and schema-validated but intentionally produce NO finding either way: Stoa has no session/auth/tenant modeling to verify them, and a missing finding here must never be read as "confirmed met".',
            de: 'Von den sechs strukturierten `security`-Flags, die eine Vertragsregel deklarieren kann, hat nur `serverSideValidation` ein echtes statisches Signal — denselben Beleg für die Backend-Zuordnung wie die obige layers-Prüfung. Die übrigen fünf (authenticationRequired, authorizationRequired, ownershipRequired, tenantIsolation, massAssignmentProtection) werden akzeptiert und schema-validiert, erzeugen aber absichtlich KEINEN Befund — Stoa hat keine Session-/Auth-/Tenant-Modellierung, um sie zu prüfen, und ein fehlender Befund hier darf niemals als „bestätigt erfüllt" gelesen werden.'
        },
        rationale: {
            en: 'A frontend check alone never satisfies a server-side validation requirement; reporting this plainly, with an explicit account of which security flags Stoa cannot check at all, is more honest than silence on either (marcus.judgment).',
            de: 'Eine reine Frontend-Prüfung erfüllt niemals eine Anforderung an serverseitige Validierung; dies offen zu melden — mit expliziter Angabe, welche Security-Flags Stoa gar nicht prüfen kann — ist ehrlicher als Schweigen zu beidem (marcus.judgment).'
        }
    }
};

/**
 * Compares `// stoa:validation <ID>` annotations (see ValidationAnnotations.ts)
 * against a loaded Validation Contract (see contracts/ValidationContract.ts).
 * This is a first, deliberately narrow vertical slice of cross-layer validation
 * consistency via stable business IDs — TypeScript only, scalar Zod schemas
 * only. It is entirely inert when no contract is supplied (opt-in via
 * `stoa analyze --contracts <file>`).
 *
 * An annotation is an analysis HINT, never proof: this rule never treats a
 * matching ID, by itself, as evidence that a check is correctly implemented or
 * actually executed — every finding below states what was (not) statically
 * verified and what remains uncertain (see each rule's missingContext).
 */
export class ValidationContractRule implements ProjectRule {
    public readonly id = 'R-VALIDATION-CONTRACT';
    public readonly version = '1.0.0';

    public constructor(private readonly contract: ValidationContract | null) {}

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (this.contract === null) {
            return [];
        }
        const annotations = this.collectAnnotations(input.facts);
        const findings: Finding[] = [];

        for (const annotation of annotations) {
            findings.push(...this.evaluateAnnotation(annotation, input));
        }
        findings.push(...this.conflicts(annotations, input));
        findings.push(...this.notImplemented(annotations, input));
        findings.push(...this.unusedValidators(input));
        findings.push(...this.rawAfterValidation(input));
        findings.push(...this.dataflowUnresolved(input));
        findings.push(...this.layerAndSecurityAttribution(annotations, input));
        return findings;
    }

    private collectAnnotations(facts: Fact[]): Array<{fact: Fact; value: AnnotationValue}> {
        const annotations: Array<{fact: Fact; value: AnnotationValue}> = [];
        for (const fact of facts) {
            if (fact.kind === 'validation.contractAnnotation') {
                annotations.push({fact, value: fact.value as unknown as AnnotationValue});
            }
        }
        return annotations;
    }

    private evaluateAnnotation(annotation: {fact: Fact; value: AnnotationValue}, input: ProjectRuleInput): Finding[] {
        const {fact, value} = annotation;
        if (!value.idValid) {
            return [this.buildFinding('R-VALIDATION-CONTRACT-INVALID-ID', fact, value.id, input)];
        }
        const contractRule = findContractRule(this.contract as ValidationContract, value.id);
        if (contractRule === null) {
            return [this.buildFinding('R-VALIDATION-CONTRACT-UNKNOWN-ID', fact, value.id, input)];
        }
        if (!value.resolved || value.conditions === undefined) {
            return [this.buildFinding('R-VALIDATION-CONTRACT-UNRESOLVED', fact, value.id, input)];
        }
        const mismatches = describeMismatches(contractRule, value.conditions);
        if (mismatches.length > 0) {
            return [this.buildFinding('R-VALIDATION-CONTRACT-MISMATCH', fact, `${value.id} — ${mismatches.join('; ')}`, input)];
        }
        return [];
    }

    // Same ID, more than one distinct set of statically extracted conditions:
    // flags every contributing annotation (symmetric — Stoa cannot tell which
    // side, if either, is correct).
    private conflicts(annotations: ReadonlyArray<{fact: Fact; value: AnnotationValue}>, input: ProjectRuleInput): Finding[] {
        const byId = new Map<string, Array<{fact: Fact; value: AnnotationValue}>>();
        for (const annotation of annotations) {
            if (!annotation.value.idValid || !annotation.value.resolved || annotation.value.conditions === undefined) {
                continue;
            }
            const group = byId.get(annotation.value.id) ?? [];
            group.push(annotation);
            byId.set(annotation.value.id, group);
        }

        const findings: Finding[] = [];
        for (const [id, group] of byId) {
            const signatures = new Set(group.map((entry) => conditionSignature(entry.value.conditions as ResolvedConditions)));
            if (signatures.size <= 1) {
                continue;
            }
            const descriptions = [...signatures].join(' vs. ');
            for (const entry of group) {
                findings.push(this.buildFinding('R-VALIDATION-CONTRACT-CONFLICT', entry.fact, `${id}: ${descriptions}`, input));
            }
        }
        return findings;
    }

    // A contract entry with no valid+resolved annotation anywhere — a
    // low-confidence prompt, explicitly not proof the rule is unimplemented.
    private notImplemented(annotations: ReadonlyArray<{fact: Fact; value: AnnotationValue}>, input: ProjectRuleInput): Finding[] {
        const contract = this.contract as ValidationContract;
        const seen = new Set(annotations.filter((entry) => entry.value.idValid).map((entry) => entry.value.id));
        const findings: Finding[] = [];
        for (const rule of contract.rules) {
            if (seen.has(rule.id)) {
                continue;
            }
            findings.push(this.buildContractOnlyFinding('R-VALIDATION-CONTRACT-NOT-IMPLEMENTED', rule.id, contract.path, input));
        }
        return findings;
    }

    // An annotated, resolvable validator whose id is known to the contract but
    // for which no `.parse()`/`.safeParse()` call exists anywhere in its file.
    // Gated on contract membership (like MISMATCH) so a malformed/unknown id
    // is reported once, by INVALID-ID/UNKNOWN-ID, not piled onto here too.
    private unusedValidators(input: ProjectRuleInput): Finding[] {
        const findings: Finding[] = [];
        for (const fact of input.facts) {
            if (fact.kind !== 'validation.annotatedValidatorUnused') {
                continue;
            }
            const value = fact.value as unknown as UsageValue;
            if (findContractRule(this.contract as ValidationContract, value.id) === null) {
                continue;
            }
            findings.push(this.buildFinding('R-VALIDATION-CONTRACT-UNUSED-VALIDATOR', fact, value.id, input));
        }
        return findings;
    }

    // A validator invoked with request data, but a raw copy of the payload
    // still reaches a persistence sink in the same function.
    private rawAfterValidation(input: ProjectRuleInput): Finding[] {
        const findings: Finding[] = [];
        for (const fact of input.facts) {
            if (fact.kind !== 'validation.rawReuseAfterValidation') {
                continue;
            }
            const value = fact.value as unknown as UsageValue;
            if (findContractRule(this.contract as ValidationContract, value.id) === null) {
                continue;
            }
            const sinks = (value.sinks ?? []).join(', ');
            findings.push(this.buildFinding('R-VALIDATION-CONTRACT-RAW-AFTER-VALIDATION', fact, `${value.id} (${sinks})`, input));
        }
        return findings;
    }

    // Where the validated value is passed to a call that LOOKS business/
    // persistence-related by name but whose implementation could not be
    // resolved within this file (ValidationDataflow.ts's `unresolved` status
    // — never promoted from `verified`/`heuristic`, only ever the specific
    // "could not establish this" case). Gated on contract membership like
    // the sibling usage-tracing findings, and deliberately only ONE finding
    // per graph even if it has multiple unresolved edges (one hop is all
    // this slice attempts, so at most one such edge exists per graph today).
    private dataflowUnresolved(input: ProjectRuleInput): Finding[] {
        const findings: Finding[] = [];
        for (const fact of input.facts) {
            if (fact.kind !== 'validation.dataflowGraph') {
                continue;
            }
            const value = fact.value as unknown as DataflowValue;
            if (findContractRule(this.contract as ValidationContract, value.id) === null) {
                continue;
            }
            const unresolved = value.graph.edges.find((edge) => edge.status === 'unresolved');
            if (unresolved === undefined) {
                continue;
            }
            findings.push(this.buildFinding('R-VALIDATION-CONTRACT-DATAFLOW-UNRESOLVED', fact, `${value.id} — ${unresolved.basis}`, input));
        }
        return findings;
    }

    // The contract's "layers"/"security" fields are a CLAIM, not proof. For
    // every id that claims the backend layer, or declares the one security
    // flag Stoa can actually check (`serverSideValidation`), confirm that at
    // least one implementation was observed fed by request-handling data —
    // reusing the Validator Dataflow Analysis's own evidence
    // (`validation.dataflowGraph` facts only exist for invocations proven
    // fed by the request). No annotation at all is already covered by
    // NOT-IMPLEMENTED, so this only fires when an annotation exists but was
    // never shown to run on the backend. The five other security flags are
    // intentionally never checked here (see R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED's
    // missingContext) — Stoa has no session/auth/tenant model to verify them.
    private layerAndSecurityAttribution(annotations: ReadonlyArray<{fact: Fact; value: AnnotationValue}>, input: ProjectRuleInput): Finding[] {
        const contract = this.contract as ValidationContract;
        const backendAttributed = new Set<string>();
        for (const fact of input.facts) {
            if (fact.kind === 'validation.dataflowGraph') {
                backendAttributed.add((fact.value as unknown as DataflowValue).id);
            }
        }
        const findings: Finding[] = [];
        for (const rule of contract.rules) {
            const claimsBackend = rule.layers?.includes('backend') ?? false;
            const requiresServerSideValidation = rule.security?.serverSideValidation === true;
            if (!claimsBackend && !requiresServerSideValidation) {
                continue;
            }
            if (backendAttributed.has(rule.id)) {
                continue;
            }
            const annotation = annotations.find((entry) => entry.value.idValid && entry.value.id === rule.id);
            if (annotation === undefined) {
                continue;
            }
            const ruleId: RuleId = requiresServerSideValidation ? 'R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED' : 'R-VALIDATION-CONTRACT-LAYER-UNRESOLVED';
            findings.push(this.buildFinding(ruleId, annotation.fact, rule.id, input));
        }
        return findings;
    }

    private buildFinding(ruleId: RuleId, fact: Fact, value: string, input: ProjectRuleInput): Finding {
        const meta = META[ruleId];
        const text = TEXT[ruleId];
        const subject = fact.subject;
        return {
            id: `finding:${ruleId}:${subject.file}:${subject.range.startLine}:${subject.range.startCol}`,
            rule: {id: ruleId, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: subject.file, range: subject.range, symbol: subject.symbol ?? '', structure: subject.kindOf},
            observation: {
                statement: localize(text.statement, input.lang).replace('{value}', value),
                evidence: [{fact: fact.kind, value: fact.value, certainty: fact.certainty}]
            },
            interpretation: {principles: resolvePrinciple(input.knowledgeBase, meta.principleId, text.rationale, input.lang), dimensions: meta.dimensions},
            severity: meta.severity,
            confidence: meta.confidence,
            certaintyBasis: meta.certaintyBasis,
            remediation: {suggestion: localize(text.suggestion, input.lang)},
            missingContext: [localize(text.missingContext, input.lang)],
            source: 'deterministic'
        };
    }

    // A finding about a contract entry with no implementation anywhere has no
    // real source location to anchor to; the contract file itself is the most
    // honest anchor (this is a property of the contract, not of any one file).
    private buildContractOnlyFinding(ruleId: RuleId, contractRuleId: string, contractPath: string, input: ProjectRuleInput): Finding {
        const meta = META[ruleId];
        const text = TEXT[ruleId];
        const range = {startLine: 1, startCol: 0, endLine: 1, endCol: 0};
        return {
            id: `finding:${ruleId}:${contractPath}:${contractRuleId}`,
            rule: {id: ruleId, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: contractPath, range, symbol: contractRuleId},
            observation: {
                statement: localize(text.statement, input.lang).replace('{value}', contractRuleId),
                evidence: [{fact: 'validation.contractAnnotation', value: `no resolvable annotation for ${contractRuleId}`, certainty: 'semantic-heuristic'}]
            },
            interpretation: {principles: resolvePrinciple(input.knowledgeBase, meta.principleId, text.rationale, input.lang), dimensions: meta.dimensions},
            severity: meta.severity,
            confidence: meta.confidence,
            certaintyBasis: meta.certaintyBasis,
            remediation: {suggestion: localize(text.suggestion, input.lang)},
            missingContext: [localize(text.missingContext, input.lang)],
            source: 'deterministic'
        };
    }
}

const describeMismatches = (contractRule: ContractRule, conditions: ResolvedConditions): string[] => {
    const mismatches: string[] = [];
    if (contractRule.dataType !== conditions.dataType) {
        mismatches.push(`dataType contract=${contractRule.dataType} actual=${conditions.dataType}`);
    }
    if (contractRule.required !== undefined && contractRule.required !== conditions.required) {
        mismatches.push(`required contract=${contractRule.required} actual=${conditions.required}`);
    }
    if (contractRule.nullable !== undefined && contractRule.nullable !== conditions.nullable) {
        mismatches.push(`nullable contract=${contractRule.nullable} actual=${conditions.nullable}`);
    }
    if (contractRule.min !== undefined) {
        // A contract min is always inclusive (no exclusive option on the
        // contract side); code that excludes the boundary (.positive() when
        // the contract's min is meant to be reachable) incorrectly rejects a
        // value the business rule says is valid, so that counts as a mismatch
        // even when the bound VALUE matches.
        const sameValue = contractRule.min === conditions.min;
        if (!sameValue || conditions.minExclusive === true) {
            const suffix = conditions.minExclusive === true ? ' (exclusive)' : '';
            mismatches.push(`min contract=${contractRule.min} actual=${conditions.min ?? 'none'}${suffix}`);
        }
    }
    if (contractRule.max !== undefined && contractRule.max !== conditions.max) {
        mismatches.push(`max contract=${contractRule.max} actual=${conditions.max ?? 'none'}`);
    }
    if (contractRule.integer !== undefined && contractRule.integer !== (conditions.integer ?? false)) {
        mismatches.push(`integer contract=${contractRule.integer} actual=${conditions.integer ?? false}`);
    }
    if (contractRule.format !== undefined) {
        // A schema that chains multiple format modifiers (e.g. .email().url())
        // satisfies the contract if the required format is AMONG the ones it
        // enforces — the extra constraint narrows further, it does not conflict.
        const actualFormats = conditions.formats ?? [];
        if (!actualFormats.includes(contractRule.format)) {
            mismatches.push(`format contract=${contractRule.format} actual=${actualFormats.join(',') || 'none'}`);
        }
    }
    if (contractRule.allowedValues !== undefined) {
        const expected = [...contractRule.allowedValues].sort();
        const actual = [...(conditions.allowedValues ?? [])].sort();
        if (expected.join(',') !== actual.join(',')) {
            mismatches.push(`allowedValues contract=${expected.join(',') || 'none'} actual=${actual.join(',') || 'none'}`);
        }
    }
    if (contractRule.normalization !== undefined) {
        const expected = [...contractRule.normalization].sort();
        const actual = [...conditions.normalization].sort();
        if (expected.join(',') !== actual.join(',')) {
            mismatches.push(`normalization contract=${expected.join(',') || 'none'} actual=${actual.join(',') || 'none'}`);
        }
    }
    return mismatches;
};

const conditionSignature = (conditions: ResolvedConditions): string => {
    const normalization = [...conditions.normalization].sort().join(',');
    const allowedValues = [...(conditions.allowedValues ?? [])].sort().join(',');
    const minSuffix = conditions.minExclusive === true ? '(excl)' : '';
    return [
        conditions.dataType,
        `required=${conditions.required}`,
        `nullable=${conditions.nullable}`,
        `min=${conditions.min ?? 'none'}${minSuffix}`,
        `max=${conditions.max ?? 'none'}`,
        `integer=${conditions.integer ?? false}`,
        `format=${[...(conditions.formats ?? [])].sort().join(',') || 'none'}`,
        `allowedValues=${allowedValues || 'none'}`,
        `normalization=${normalization || 'none'}`
    ].join('|');
};

const resolvePrinciple = (knowledgeBase: KnowledgeBase, principleId: string, rationale: LocalizedText, lang: string): PrincipleInterpretationRef[] => {
    const principle = knowledgeBase.get(principleId);
    if (principle === null) {
        return [];
    }
    return [
        {
            id: principle.id,
            name: localize(principle.name, lang),
            passages: principle.passages,
            attributionConfidence: principle.attributionConfidence,
            rationale: localize(rationale, lang)
        }
    ];
};
