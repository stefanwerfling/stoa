import type {Fact, Finding, Severity} from '../../Types.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {LifecycleCall, LifecycleCreation, LifecycleRange, StateLifecycleValue} from '../../analysis/dart/FlutterLifecycle.js';
import {resolvedFrom, type DartNameResolution} from '../../model/DartLibraryIndex.js';
import {flutterAwareIndex} from '../../analysis/dart/FlutterCatalog.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';
import {resolvePrinciple} from './FlutterLayoutRules.js';

/**
 * Flutter State lifecycle rules (Flutter Phase 3). They read only
 * `dart.stateLifecycle` facts (one per `extends State<…>` class, see
 * analysis/dart/FlutterLifecycle.ts) plus the identity facts
 * (`dart.importSpec`, `dart.classDecl`) — no widget graph, no AST.
 *
 * Shared discipline:
 * - the class's `State` must be Flutter's: the DartLibraryIndex (Phase B,
 *   rules 1.1.0) must RESOLVE it to a `package:flutter/` declaration (a
 *   `State` declared in the same library shadows it; ambiguous/unresolved
 *   never counts);
 * - framework names the rules look for (`TextEditingController`, `Theme`,
 *   `Timer`) are resolved the same way — Flutter names to a
 *   `package:flutter/` declaration, `Timer` to `dart:async`;
 * - a class mixing in anything outside a small list of known framework
 *   mixins is skipped by the dispose rules: such a mixin may release fields
 *   in its own `dispose()`;
 * - DISPOSE = any mention of the field in `dispose()` or in a same-class
 *   method it calls (user decision: minimise false positives; a field that
 *   is mentioned but not actually released is a documented false negative).
 *
 * Resource model (Flutter quality track, Phase C — rules 1.2.0). Per field:
 * - CREATED for certain: assigned exactly one call whose type the
 *   DartLibraryIndex resolves (framework controller, `Timer`), or a
 *   `.listen(…)` stored in a field DECLARED `StreamSubscription` (resolved to
 *   dart:async); a `.listen(…)` into an untyped or otherwise-typed field is
 *   only POSSIBLY a subscription (own `listen()` APIs) — never reported;
 * - MANAGED ELSEWHERE: the field is also assigned from something else
 *   (`widget.controller`, a parameter, `a ?? b`) — ownership cannot be judged,
 *   the field is skipped;
 * - RELEASED for certain: `.dispose()`/`.cancel()`/`.close()` on it in the
 *   dispose() chain (`releaseCalls`); MENTIONED: any other mention there
 *   (counts as released, see above); NOT PROVABLY RELEASED: neither — the
 *   only state that is reported.
 * setState after await (1.2.0) is reported only when no `mounted` check
 * occurs after the await (`none`) or every check provably does not guard the
 * call (`non-dominating`); a check the analysis cannot place (`unknown`) keeps
 * the rule silent. See FlutterLifecycle.ts `MountedGuard`.
 */

const FLUTTER_PACKAGE = 'package:flutter/';
const DART_ASYNC = 'dart:async';

const CONTROLLERS: ReadonlySet<string> = new Set([
    'TextEditingController',
    'AnimationController',
    'ScrollController',
    'TrackingScrollController',
    'PageController',
    'TabController',
    'FocusNode',
    'FocusScopeNode',
    'TransformationController',
    'SearchController'
]);

const INHERITED_LOOKUPS: ReadonlySet<string> = new Set([
    'Theme',
    'MediaQuery',
    'Localizations',
    'MaterialLocalizations',
    'CupertinoLocalizations',
    'Directionality',
    'DefaultTextStyle',
    'IconTheme',
    'ScaffoldMessenger',
    'CupertinoTheme'
]);

// Framework mixins known not to release a State's own fields.
const KNOWN_MIXINS: ReadonlySet<string> = new Set([
    'TickerProviderStateMixin',
    'SingleTickerProviderStateMixin',
    'AutomaticKeepAliveClientMixin',
    'WidgetsBindingObserver',
    'RestorationMixin',
    'RouteAware'
]);

type Resolve = (file: string, name: string, prefix: string | null) => DartNameResolution;

// Phase B (rules 1.1.0): only a name the DartLibraryIndex RESOLVES to a
// declaration below `source` counts — ambiguous/unresolved never does.
const fromSource = (resolution: DartNameResolution, source: string): boolean => resolvedFrom(resolution, source);

interface StateClass {
    fact: Fact;
    value: StateLifecycleValue;
}

interface LifecycleText {
    statement: LocalizedText;
    suggestion: LocalizedText;
    drawbacks: LocalizedText;
    missingContext: LocalizedText;
    rationale: LocalizedText;
}

interface Hit {
    state: StateClass;
    range: LifecycleRange;
    /** Filled into `{subject}` (field name, call). */
    subject: string;
    /** Fact-value summary for the evidence. */
    evidence: string;
}

abstract class FlutterLifecycleRule implements ProjectRule {
    public abstract readonly id: string;
    public readonly version: string = '1.1.0';
    public readonly requiredFactKinds = ['dart.stateLifecycle', 'dart.classDecl', 'dart.importSpec'];
    protected abstract readonly text: LifecycleText;
    protected abstract readonly principleId: string;
    protected abstract readonly severity: Severity;
    protected readonly confidence: number = 0.8;

    protected abstract hits(state: StateClass, resolve: Resolve): Hit[];

    public evaluate(input: ProjectRuleInput): Finding[] {
        const states = input.facts.filter((fact) => fact.kind === 'dart.stateLifecycle');
        if (states.length === 0) {
            return [];
        }
        const index = input.dartLibraryIndex ?? flutterAwareIndex(input.facts);
        const resolve: Resolve = (file, name, prefix) => index.resolve(file, name, prefix);
        const findings: Finding[] = [];
        for (const fact of states) {
            const value = fact.value as unknown as StateLifecycleValue;
            if (!fromSource(resolve(fact.subject.file, 'State', value.statePrefix), FLUTTER_PACKAGE)) {
                continue;
            }
            for (const hit of this.hits({fact, value}, resolve)) {
                findings.push(this.buildFinding(hit, input));
            }
        }
        return findings;
    }

    private buildFinding(hit: Hit, input: ProjectRuleInput): Finding {
        const {state, range} = hit;
        const fill = (text: LocalizedText): string => localize(text, input.lang).replaceAll('{subject}', hit.subject).replaceAll('{class}', state.value.className);
        return {
            id: `finding:${this.id}:${state.fact.subject.file}:${range.startLine}:${range.startCol}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: state.fact.subject.file, range, symbol: state.value.className, structure: 'class'},
            observation: {
                statement: fill(this.text.statement),
                evidence: [{fact: 'dart.stateLifecycle', value: hit.evidence, certainty: 'syntactic'}]
            },
            interpretation: {principles: resolvePrinciple(input.knowledgeBase, input.lang, fill(this.text.rationale), this.principleId), dimensions: ['robustness']},
            severity: this.severity,
            confidence: this.confidence,
            certaintyBasis: 'syntactic',
            remediation: {suggestion: fill(this.text.suggestion), drawbacks: fill(this.text.drawbacks)},
            missingContext: [fill(this.text.missingContext)],
            source: 'deterministic'
        };
    }
}

const callText = (call: LifecycleCall): string => `${call.prefix === null ? '' : `${call.prefix}.`}${call.names.join('.')}`;

const hasUnknownMixin = (value: StateLifecycleValue): boolean => value.mixins.some((mixin) => !KNOWN_MIXINS.has(mixin));

/** Fields created by a call `accept`s and never mentioned in dispose(); one hit per field (its first creation). */
const unreleased = (state: StateClass, accept: (call: LifecycleCreation) => boolean): Hit[] => {
    const {value} = state;
    if (hasUnknownMixin(value)) {
        return [];
    }
    const mentioned = new Set(value.disposeMentions);
    const external = new Set(value.externalFields);
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const creation of value.creations) {
        if (seen.has(creation.field) || mentioned.has(creation.field) || external.has(creation.field) || !accept(creation)) {
            continue;
        }
        seen.add(creation.field);
        hits.push({
            state,
            range: creation.range,
            subject: `${creation.field} (${callText(creation)})`,
            evidence: `${value.className}.${creation.field} = ${callText(creation)}; dispose: ${value.hasDispose ? 'no mention' : 'absent'}`
        });
    }
    return hits;
};

/** True when `field` is declared with a type that resolves to `name` from `source` (e.g. `StreamSubscription<int>?` → dart:async). */
const declaredAs = (state: StateClass, field: string, resolve: Resolve, name: string, source: string): boolean => {
    const type = state.value.fieldTypes?.[state.value.fields.indexOf(field)] ?? null;
    return type !== null && type[1] === name && fromSource(resolve(state.fact.subject.file, name, type[0]), source);
};

const DISPOSE_CONTEXT: LocalizedText = {
    en: 'Any mention of the field in dispose() or in a same-class method it calls counts as released. A field also assigned from elsewhere (widget.controller, a parameter, a ?? b) is skipped: its ownership is not judged. A base class other than State, a mixin outside the known framework mixins, or ownership handed to another object after creation is not followed; such classes are skipped or may be false positives.',
    de: 'Jede Erwähnung des Felds in dispose() oder in einer von dort aufgerufenen Methode derselben Klasse gilt als Freigabe. Ein Feld, das auch anderweitig zugewiesen wird (widget.controller, ein Parameter, a ?? b), wird übersprungen: seine Verantwortung wird nicht beurteilt. Eine andere Basisklasse als State, ein Mixin außerhalb der bekannten Framework-Mixins oder eine nach der Erzeugung an ein anderes Objekt übergebene Verantwortung werden nicht verfolgt; solche Klassen werden übersprungen oder können Fehlalarme sein.'
};

/** R-FLUTTER-UNDISPOSED-CONTROLLER: a framework controller/FocusNode held in a field and never released in dispose(). */
export class FlutterUndisposedControllerRule extends FlutterLifecycleRule {
    public readonly id = 'R-FLUTTER-UNDISPOSED-CONTROLLER';
    public override readonly version = '1.2.0';
    protected readonly principleId = 'marcus.control';
    protected readonly severity: Severity = 'medium';
    protected readonly text: LifecycleText = {
        statement: {en: '{class} creates {subject} but never disposes it in dispose().', de: '{class} erzeugt {subject}, gibt es in dispose() aber nie frei.'},
        suggestion: {en: 'Call .dispose() on the field in the State\'s dispose(), before super.dispose().', de: 'In dispose() des State .dispose() auf dem Feld aufrufen, vor super.dispose().'},
        drawbacks: {en: 'None of note.', de: 'Keine nennenswerten.'},
        missingContext: DISPOSE_CONTEXT,
        rationale: {
            en: 'A controller holds listeners, tickers or focus registrations that outlive the State unless released; what the State created is its own to clean up (marcus.control).',
            de: 'Ein Controller hält Listener, Ticker oder Fokus-Registrierungen, die den State überleben, wenn sie nicht freigegeben werden; was der State erzeugt hat, muss er selbst aufräumen (marcus.control).'
        }
    };

    protected hits(state: StateClass, resolve: Resolve): Hit[] {
        return unreleased(state, (call) => {
            const [type] = call.names;
            return call.names.length <= 2 && type !== undefined && CONTROLLERS.has(type) && fromSource(resolve(state.fact.subject.file, type, call.prefix), FLUTTER_PACKAGE);
        });
    }
}

/** R-FLUTTER-UNCANCELLED-SUBSCRIPTION: a Timer or stream subscription held in a field and never cancelled in dispose(). */
export class FlutterUncancelledSubscriptionRule extends FlutterLifecycleRule {
    public readonly id = 'R-FLUTTER-UNCANCELLED-SUBSCRIPTION';
    public override readonly version = '1.2.0';
    protected readonly principleId = 'marcus.control';
    protected readonly severity: Severity = 'medium';
    protected readonly text: LifecycleText = {
        statement: {en: '{class} starts {subject} but never cancels it in dispose().', de: '{class} startet {subject}, bricht es in dispose() aber nie ab.'},
        suggestion: {en: 'Call .cancel() on the field in the State\'s dispose().', de: 'In dispose() des State .cancel() auf dem Feld aufrufen.'},
        drawbacks: {en: 'None of note.', de: 'Keine nennenswerten.'},
        missingContext: {
            en: `${localize(DISPOSE_CONTEXT, 'en')} A \`.listen(…)\` result counts as a subscription only when the field is declared \`StreamSubscription\` (dart:async); an untyped field or an own listen() API is not reported, nor are subscriptions kept in a collection.`,
            de: `${localize(DISPOSE_CONTEXT, 'de')} Ein \`.listen(…)\`-Ergebnis gilt nur als Subscription, wenn das Feld als \`StreamSubscription\` (dart:async) deklariert ist; ein untypisiertes Feld oder eine eigene listen()-API wird nicht gemeldet, ebenso wenig Subscriptions in einer Sammlung.`
        },
        rationale: {
            en: 'A timer or subscription keeps firing after the State is gone — typically into setState() after dispose(); the State must stop what it started (marcus.control).',
            de: 'Ein Timer oder eine Subscription feuert weiter, wenn der State weg ist — typischerweise in setState() nach dispose(); der State muss beenden, was er gestartet hat (marcus.control).'
        }
    };

    protected hits(state: StateClass, resolve: Resolve): Hit[] {
        return unreleased(state, (call) => {
            const [first] = call.names;
            const isTimer = first === 'Timer' && call.names.length <= 2 && (call.names[1] === undefined || call.names[1] === 'periodic') && fromSource(resolve(state.fact.subject.file, 'Timer', call.prefix), DART_ASYNC);
            const isSubscription = call.names.length >= 2 && call.names.at(-1) === 'listen' && declaredAs(state, call.field, resolve, 'StreamSubscription', DART_ASYNC);
            return isTimer || isSubscription;
        });
    }
}

/** R-FLUTTER-SETSTATE-AFTER-AWAIT: setState() after an await in the same function without a `mounted` check in between. */
export class FlutterSetStateAfterAwaitRule extends FlutterLifecycleRule {
    public readonly id = 'R-FLUTTER-SETSTATE-AFTER-AWAIT';
    public override readonly version = '1.2.0';
    protected readonly principleId = 'marcus.control';
    protected readonly severity: Severity = 'medium';
    protected override readonly confidence = 0.7;
    protected readonly text: LifecycleText = {
        statement: {en: 'setState() in {subject} follows an await without a mounted check in between.', de: 'setState() in {subject} folgt auf ein await ohne mounted-Prüfung dazwischen.'},
        suggestion: {en: 'Add `if (!mounted) return;` after the await (before setState).', de: 'Nach dem await (vor setState) `if (!mounted) return;` einfügen.'},
        drawbacks: {en: 'None of note.', de: 'Keine nennenswerten.'},
        missingContext: {
            en: 'Order is source order within one function body (an await in a loop after the setState is not modelled). A mounted check counts only as the condition of an if/?: in the same function that guards the call: `if (!mounted) return;` before it in an enclosing block, or the call inside `if (mounted) {…}`; any other use of mounted (a variable, a loop, `== true`, another closure) keeps the rule silent. A guard via another flag than `mounted` is not recognised.',
            de: 'Reihenfolge ist die Quelltextreihenfolge innerhalb eines Funktionsrumpfs (ein await in einer Schleife nach dem setState wird nicht modelliert). Eine mounted-Prüfung zählt nur als Bedingung eines if/?: in derselben Funktion, das den Aufruf absichert: `if (!mounted) return;` davor in einem umschließenden Block oder der Aufruf innerhalb von `if (mounted) {…}`; jede andere Verwendung von mounted (Variable, Schleife, `== true`, andere Closure) lässt die Regel schweigen. Eine Absicherung über ein anderes Flag als `mounted` wird nicht erkannt.'
        },
        rationale: {
            en: 'While awaiting, the widget may be removed; calling setState() on a disposed State throws in debug. Whether the State still exists is outside its control and must be checked, not assumed (marcus.control).',
            de: 'Während des Wartens kann das Widget entfernt werden; setState() auf einem entsorgten State wirft im Debug-Modus. Ob der State noch existiert, liegt außerhalb seiner Kontrolle und muss geprüft, nicht angenommen werden (marcus.control).'
        }
    };

    protected hits(state: StateClass): Hit[] {
        return state.value.setStateCalls
            .filter((call) => call.afterAwait && (call.guard === 'none' || call.guard === 'non-dominating'))
            .map((call) => {
                const awaitAt = call.awaitRange === null ? '' : ` (line ${call.awaitRange.startLine})`;
                const guard = call.guard === 'none' || call.mountedRange === null ? 'no mounted' : `mounted (line ${call.mountedRange.startLine}) does not guard it`;
                return {
                    state,
                    range: call.range,
                    subject: `${state.value.className}.${call.method}`,
                    evidence: `${state.value.className}.${call.method}: await${awaitAt} → setState (line ${call.range.startLine}), ${guard}`
                };
            });
    }
}

/** R-FLUTTER-INHERITED-IN-INITSTATE: an inherited-widget lookup (`Theme.of(context)`, …) directly in initState(). */
export class FlutterInheritedInInitStateRule extends FlutterLifecycleRule {
    public readonly id = 'R-FLUTTER-INHERITED-IN-INITSTATE';
    protected readonly principleId = 'marcus.judgment';
    protected readonly severity: Severity = 'high';
    protected readonly text: LifecycleText = {
        statement: {en: '{class}.initState() calls {subject}.', de: '{class}.initState() ruft {subject} auf.'},
        suggestion: {
            en: 'Move the lookup to didChangeDependencies() or build(), or defer it with WidgetsBinding.instance.addPostFrameCallback.',
            de: 'Die Abfrage nach didChangeDependencies() oder build() verschieben oder mit WidgetsBinding.instance.addPostFrameCallback aufschieben.'
        },
        drawbacks: {
            en: 'didChangeDependencies() runs again whenever the dependency changes; keep the work there idempotent.',
            de: 'didChangeDependencies() läuft bei jeder Änderung der Abhängigkeit erneut; die Arbeit dort idempotent halten.'
        },
        missingContext: {
            en: 'Only direct calls in initState() with `context` as a positional argument on a fixed list of framework classes are checked; closures (post-frame callbacks, futures) are excluded, helper methods called from initState() are not followed.',
            de: 'Geprüft werden nur direkte Aufrufe in initState() mit `context` als Positionsargument auf einer festen Liste von Framework-Klassen; Closures (Post-Frame-Callbacks, Futures) sind ausgenommen, aus initState() aufgerufene Hilfsmethoden werden nicht verfolgt.'
        },
        rationale: {
            en: 'initState() runs before the element is wired into inherited-widget dependencies; the lookup contradicts the lifecycle contract and throws "dependOnInheritedWidgetOfExactType … called before initState() completed" (marcus.judgment).',
            de: 'initState() läuft, bevor das Element in die Inherited-Widget-Abhängigkeiten eingebunden ist; die Abfrage widerspricht dem Lifecycle-Vertrag und wirft "dependOnInheritedWidgetOfExactType … called before initState() completed" (marcus.judgment).'
        }
    };

    protected hits(state: StateClass, resolve: Resolve): Hit[] {
        return state.value.initStateContextCalls
            .filter((call) => {
                const [type, method] = call.names;
                return (
                    call.names.length === 2 &&
                    type !== undefined &&
                    method !== undefined &&
                    INHERITED_LOOKUPS.has(type) &&
                    (method === 'of' || method === 'maybeOf' || /^[a-z]\w*Of$/.test(method)) &&
                    fromSource(resolve(state.fact.subject.file, type, call.prefix), FLUTTER_PACKAGE)
                );
            })
            .map((call) => ({state, range: call.range, subject: `${callText(call)}(context)`, evidence: `${state.value.className}.initState: ${callText(call)}(context)`}));
    }
}

/** The Flutter lifecycle rules, in a fixed order (findings are sorted by the engine anyway). */
export const flutterLifecycleRules = (): ProjectRule[] => [
    new FlutterUndisposedControllerRule(),
    new FlutterUncancelledSubscriptionRule(),
    new FlutterSetStateAfterAwaitRule(),
    new FlutterInheritedInInitStateRule()
];
