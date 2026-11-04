import type {Finding, PrincipleInterpretationRef} from '../../Types.js';
import {ordinalSymbols} from '../../FindingIdentity.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {KnowledgeBase} from '../../knowledge/KnowledgeBase.js';
import {argValueOf, type FlutterWidgetGraph, type WidgetEdge, type WidgetNode} from '../../model/FlutterWidgetGraph.js';
import {axisLiteral, boolLiteral, type ArgValue} from '../../analysis/dart/DartValues.js';
import {resolvedFrom} from '../../model/DartLibraryIndex.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';

/**
 * Flutter layout rules (Flutter Phase 2) — the first consumers of the
 * FlutterWidgetGraph. Each one reports a parent/child combination the Flutter
 * framework rejects at RUNTIME with a layout exception (red error screen in
 * debug, a grey box in release), which `flutter analyze` does not report.
 *
 * Shared, deliberately conservative discipline:
 * - IDENTITY (Phase B, rules 1.1.0/1.2.0): a widget counts as the Flutter
 *   widget of that name only when the DartLibraryIndex RESOLVES it to a
 *   declaration below `package:flutter/` — through a Flutter import, a prefix,
 *   or a project barrel re-exporting Flutter. A declaration of that name in
 *   the same library (incl. its parts) shadows the framework class; a name
 *   that two imports provide differently is `ambiguous` and an unprovable one
 *   `unresolved` — neither is ever treated as a Flutter widget.
 * - STRUCTURE: the effective parent is found by walking up through the
 *   transparent nodes only (`conditional`, `repeat`, `spread`, `list` — they
 *   place their elements into the same slot). A `builder`, `reference`,
 *   `dynamic` or `unparsed` node on the way, a root, or a non-`known` status
 *   ends the walk WITHOUT a finding: the real parent is not known.
 * - PARENT SETS are curated allowlists of framework widgets whose behaviour
 *   for that slot is fixed. An unknown/custom parent is never assumed to be
 *   wrong (a StatelessWidget wrapper may legitimately pass the child through).
 * - ARGUMENT VALUES come from the graph's value semantics (DartValues): an
 *   absent argument takes the framework default, a literal (`true`/`false`,
 *   `Axis.vertical`/`Axis.horizontal`) is used as written, and anything else
 *   (variable, expression) is UNKNOWN — a rule reports only what the known
 *   values make certain.
 */

const PRINCIPLE_ID = 'marcus.judgment';
const FLUTTER_PACKAGE = 'package:flutter/';
const TRANSPARENT: ReadonlySet<string> = new Set(['conditional', 'repeat', 'spread', 'list']);

export interface EffectiveParent {
    parent: WidgetNode;
    /** The slot of `parent` that (through transparent nodes) holds the child. */
    slot: string;
}

/** Index over a graph: node by id, incoming edge by child id. */
export class WidgetGraphIndex {
    private readonly nodes = new Map<string, WidgetNode>();
    private readonly incoming = new Map<string, WidgetEdge>();

    public constructor(public readonly graph: FlutterWidgetGraph) {
        for (const node of graph.nodes) {
            this.nodes.set(node.id, node);
        }
        for (const edge of graph.edges) {
            this.incoming.set(edge.child, edge);
        }
    }

    /**
     * The nearest widget above `node`, looking only through transparent nodes;
     * null when the parent is unknown (root, builder, reference, dynamic,
     * unparsed, or any non-`known` node on the way).
     */
    public effectiveParent(node: WidgetNode): EffectiveParent | null {
        let current = node;
        for (;;) {
            const edge = this.incoming.get(current.id);
            const parent = edge === undefined ? undefined : this.nodes.get(edge.parent);
            if (edge === undefined || parent === undefined || parent.status !== 'known') {
                return null;
            }
            if (parent.kind === 'widget') {
                return {parent, slot: edge.label};
            }
            if (!TRANSPARENT.has(parent.kind)) {
                return null;
            }
            current = parent;
        }
    }
}

/** True when `node` is a known Flutter-framework widget named one of `names` (see IDENTITY above). */
export const isFlutterWidget = (node: WidgetNode, names: ReadonlySet<string>): boolean =>
    node.kind === 'widget' &&
    node.status === 'known' &&
    node.name !== null &&
    names.has(node.name) &&
    resolvedFrom(node.resolution, FLUTTER_PACKAGE);

const displayName = (node: WidgetNode): string => `${node.name ?? '?'}${node.constructorName === null ? '' : `.${node.constructorName}`}`;

/** The owning function (without its `@line`) and the widget: `build>ListView.builder`. */
const symbolBase = (node: WidgetNode): string => `${node.owner.slice(0, node.owner.lastIndexOf('@'))}>${displayName(node)}`;

// Framework widgets that wrap their single `child` in their own render object
// (or render-object-building subtree): a ParentDataWidget placed directly in
// such a slot never reaches a Flex/Stack.
const SINGLE_CHILD_BOXES = [
    'Padding',
    'Align',
    'Center',
    'SizedBox',
    'ConstrainedBox',
    'UnconstrainedBox',
    'LimitedBox',
    'FractionallySizedBox',
    'AspectRatio',
    'FittedBox',
    'DecoratedBox',
    'ColoredBox',
    'Opacity',
    'Transform',
    'RotatedBox',
    'ClipRect',
    'ClipRRect',
    'ClipOval',
    'ClipPath',
    'Baseline',
    'IntrinsicHeight',
    'IntrinsicWidth',
    'Card',
    'SingleChildScrollView'
];
const FLEX = new Set(['Row', 'Column', 'Flex']);
const STACKS = new Set(['Stack', 'IndexedStack']);
const MULTI_CHILD_NON_FLEX = ['Wrap', 'ListView', 'GridView'];
const SCROLLABLES = new Set(['ListView', 'GridView', 'CustomScrollView', 'PageView', 'ReorderableListView']);
const SHRINKABLE_SCROLLABLES = new Set(['ListView', 'GridView', 'CustomScrollView', 'ReorderableListView']);
const OUTER_SCROLLERS = new Set(['SingleChildScrollView', 'ListView']);

type Axis = 'vertical' | 'horizontal';

// `scrollDirection` defaults: every scrollable here is vertical except PageView.
const DEFAULT_SCROLL_AXIS: Readonly<Record<string, Axis>> = {
    ListView: 'vertical',
    GridView: 'vertical',
    CustomScrollView: 'vertical',
    ReorderableListView: 'vertical',
    SingleChildScrollView: 'vertical',
    PageView: 'horizontal'
};

interface Resolved<T> {
    value: T | null;
    /** How the value was obtained, for the evidence: `default`, `literal`, `unknown`. */
    source: 'default' | 'literal' | 'unknown';
}

const resolve = <T>(value: ArgValue | undefined, fallback: T, read: (value: ArgValue) => T | null): Resolved<T> => {
    if (value === undefined) {
        return {value: fallback, source: 'default'};
    }
    const literal = read(value);
    return literal === null ? {value: null, source: 'unknown'} : {value: literal, source: 'literal'};
};

/** The scroll axis of a scrollable: its `scrollDirection` literal, the default when absent, unknown otherwise. */
const scrollAxis = (node: WidgetNode): Resolved<Axis> =>
    resolve<Axis>(argValueOf(node, 'scrollDirection'), DEFAULT_SCROLL_AXIS[node.name ?? ''] ?? 'vertical', (value) => axisLiteral(value));

/** `shrinkWrap` (default false; PageView has none, so always false). */
const shrinkWrap = (node: WidgetNode): Resolved<boolean> =>
    SHRINKABLE_SCROLLABLES.has(node.name ?? '') ? resolve<boolean>(argValueOf(node, 'shrinkWrap'), false, (value) => boolLiteral(value)) : {value: false, source: 'default'};

/** The main axis of a Flex: Row horizontal, Column vertical, Flex its required `direction` literal (unknown otherwise). */
const flexAxis = (node: WidgetNode): Resolved<Axis> => {
    if (node.name === 'Row') {
        return {value: 'horizontal', source: 'default'};
    }
    if (node.name === 'Column') {
        return {value: 'vertical', source: 'default'};
    }
    const direction = argValueOf(node, 'direction');
    const axis = axisLiteral(direction);
    return axis === null ? {value: null, source: 'unknown'} : {value: axis, source: 'literal'};
};

const describe = <T>(name: string, resolved: Resolved<T>): string => `${name}=${resolved.value === null ? '?' : String(resolved.value)} (${resolved.source})`;

/**
 * Whether a viewport placed where the parent leaves `parentAxis` UNBOUNDED
 * (and bounds the other axis) certainly throws. A normal viewport needs both
 * axes bounded; a shrink-wrapping one sizes itself along its own scroll axis
 * but still needs a bounded cross axis (RenderShrinkWrappingViewport). So:
 * - shrinkWrap false (written or default) → throws, whatever the axes;
 * - shrinkWrap true or unknown → throws only when both axes are known and the
 *   scroll axis differs from `parentAxis` (the unbounded axis is its cross axis);
 * - otherwise not certain → no finding.
 */
const viewportThrows = (child: WidgetNode, parentAxis: Resolved<Axis>): {throws: boolean; detail: string} => {
    const shrink = shrinkWrap(child);
    const axis = scrollAxis(child);
    const detail = `${describe('shrinkWrap', shrink)}, ${describe('scrollDirection', axis)}, parent axis=${parentAxis.value ?? '?'} (${parentAxis.source})`;
    if (shrink.value === false) {
        return {throws: true, detail};
    }
    return {throws: axis.value !== null && parentAxis.value !== null && axis.value !== parentAxis.value, detail};
};
const TEXT_FIELDS = new Set(['TextField', 'TextFormField']);

interface LayoutRuleText {
    statement: LocalizedText;
    suggestion: LocalizedText;
    drawbacks: LocalizedText;
    missingContext: LocalizedText;
    rationale: LocalizedText;
}

interface Match {
    child: WidgetNode;
    parent: WidgetNode;
    slot: string;
    /** What the child needs instead (filled into `{expected}`); empty when the text does not use it. */
    expected: string;
    /** The argument values the decision rests on, appended to the evidence; empty when none. */
    detail?: string;
}

/** Common finding assembly for the layout rules; subclasses only find matches. */
abstract class FlutterLayoutRule implements ProjectRule {
    public abstract readonly id: string;
    public readonly version: string = '1.2.0';
    public readonly requiredFactKinds = ['ui.flutterWidgetTree', 'dart.classDecl', 'dart.importSpec'];
    protected abstract readonly text: LayoutRuleText;
    protected readonly confidence: number = 0.8;

    protected abstract matches(index: WidgetGraphIndex): Match[];

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (input.flutterWidgetGraph === undefined || input.flutterWidgetGraph.nodes.length === 0) {
            return [];
        }
        const index = new WidgetGraphIndex(input.flutterWidgetGraph);
        const matches = this.matches(index).sort(
            (a, b) => (a.child.file < b.child.file ? -1 : a.child.file > b.child.file ? 1 : 0) || a.child.range.startLine - b.child.range.startLine || a.child.range.startCol - b.child.range.startCol
        );
        // Identity: the owning function and the widget, numbered per file in
        // source order (`build>ListView#1`) — one build() can misplace the same
        // widget several times, and two classes in one file can both own a build().
        const symbols = ordinalSymbols(matches.map((match) => `${match.child.file}\n${symbolBase(match.child)}`));
        return matches.map((match, position) => this.buildFinding(match, (symbols[position] as string).slice(match.child.file.length + 1), input));
    }

    private buildFinding(match: Match, symbol: string, input: ProjectRuleInput): Finding {
        const {child, parent, slot, expected} = match;
        const fill = (text: LocalizedText): string =>
            localize(text, input.lang)
                .replaceAll('{child}', displayName(child))
                .replaceAll('{parent}', displayName(parent))
                .replaceAll('{slot}', slot)
                .replaceAll('{expected}', expected);
        return {
            id: `finding:${this.id}:${child.file}:${child.range.startLine}:${child.range.startCol}`,
            rule: {id: this.id, version: this.version},
            ruleSet: input.ruleSetId,
            location: {file: child.file, range: child.range, symbol, structure: 'widget'},
            observation: {
                statement: fill(this.text.statement),
                evidence: [{fact: 'ui.flutterWidgetTree', value: `${displayName(parent)}.${slot} > ${displayName(child)}${match.detail === undefined || match.detail === '' ? '' : ` [${match.detail}]`}`, certainty: 'syntactic'}]
            },
            interpretation: {principles: resolvePrinciple(input.knowledgeBase, input.lang, fill(this.text.rationale)), dimensions: ['robustness']},
            severity: 'high',
            confidence: this.confidence,
            certaintyBasis: 'syntactic',
            remediation: {suggestion: fill(this.text.suggestion), drawbacks: fill(this.text.drawbacks)},
            missingContext: [fill(this.text.missingContext)],
            source: 'deterministic'
        };
    }
}

interface BilingualText {
    en: string;
    de: string;
}

const IDENTITY_CONTEXT: BilingualText = {
    en: 'Widgets are identified by resolving their name through the library\'s imports, prefixes and project re-exports to a package:flutter declaration (no type inference); names that are ambiguous or come through an uninspectable third-party library are not reported.',
    de: 'Widgets werden erkannt, indem ihr Name über Importe, Präfixe und Re-Exporte des Projekts zu einer package:flutter-Deklaration aufgelöst wird (keine Typinferenz); mehrdeutige oder nur über eine nicht einsehbare Fremdbibliothek erreichbare Namen werden nicht gemeldet.'
};

const withIdentity = (text: BilingualText): LocalizedText => ({
    en: `${text.en} ${IDENTITY_CONTEXT.en}`,
    de: `${text.de} ${IDENTITY_CONTEXT.de}`
});

/** Collects every widget named in `childNames` whose effective parent passes `accept`. */
const collect = (
    index: WidgetGraphIndex,
    childNames: ReadonlySet<string>,
    accept: (child: WidgetNode, parent: WidgetNode, slot: string) => boolean,
    expected = ''
): Match[] => {
    const result: Match[] = [];
    for (const child of index.graph.nodes) {
        if (!isFlutterWidget(child, childNames)) {
            continue;
        }
        const effective = index.effectiveParent(child);
        if (effective !== null && accept(child, effective.parent, effective.slot)) {
            result.push({child, parent: effective.parent, slot: effective.slot, expected});
        }
    }
    return result;
};

/**
 * R-FLUTTER-PARENTDATA-MISUSE: `Expanded`/`Flexible`/`Spacer` directly in a
 * non-Flex framework widget, or `Positioned` (and its variants) directly in a
 * non-Stack framework widget — "Incorrect use of ParentDataWidget".
 */
export class FlutterParentDataMisuseRule extends FlutterLayoutRule {
    public readonly id = 'R-FLUTTER-PARENTDATA-MISUSE';
    private static readonly FLEX_CHILDREN = new Set(['Expanded', 'Flexible', 'Spacer']);
    private static readonly STACK_CHILDREN = new Set(['Positioned', 'PositionedDirectional', 'AnimatedPositioned', 'AnimatedPositionedDirectional']);
    private static readonly BAD_FOR_FLEX_CHILD = new Set([...SINGLE_CHILD_BOXES, ...STACKS, ...MULTI_CHILD_NON_FLEX]);
    private static readonly BAD_FOR_STACK_CHILD = new Set([...SINGLE_CHILD_BOXES, ...FLEX, ...MULTI_CHILD_NON_FLEX]);
    protected readonly text: LayoutRuleText = {
        statement: {en: '{child} is placed in {parent}.{slot}, which is not a {expected}.', de: '{child} steht in {parent}.{slot}, das kein {expected} ist.'},
        suggestion: {
            en: 'Place {child} directly in the children of the widget it configures, or drop it and size the child with SizedBox/Align instead.',
            de: '{child} direkt in die children des Widgets setzen, das es konfiguriert, oder es entfernen und das Kind mit SizedBox/Align dimensionieren.'
        },
        drawbacks: {en: 'None of note; the current combination throws at runtime.', de: 'Keine nennenswerten; die jetzige Kombination wirft zur Laufzeit.'},
        missingContext: withIdentity({
            en: 'Only a fixed set of framework parents is checked; a custom or unknown parent widget (which may pass the child through) is never reported.',
            de: 'Geprüft wird nur eine feste Menge von Framework-Eltern; ein eigenes oder unbekanntes Eltern-Widget (das das Kind durchreichen kann) wird nie gemeldet.'
        }),
        rationale: {
            en: 'A ParentDataWidget declares layout data for a specific parent type; placed under another, the declaration contradicts what the framework does and it throws "Incorrect use of ParentDataWidget" (marcus.judgment).',
            de: 'Ein ParentDataWidget deklariert Layoutdaten für einen bestimmten Elterntyp; unter einem anderen widerspricht die Deklaration dem, was das Framework tut, und es wirft "Incorrect use of ParentDataWidget" (marcus.judgment).'
        }
    };

    protected matches(index: WidgetGraphIndex): Match[] {
        const flex = collect(index, FlutterParentDataMisuseRule.FLEX_CHILDREN, (_child, parent) => isFlutterWidget(parent, FlutterParentDataMisuseRule.BAD_FOR_FLEX_CHILD), 'Row/Column/Flex');
        const stack = collect(index, FlutterParentDataMisuseRule.STACK_CHILDREN, (_child, parent) => isFlutterWidget(parent, FlutterParentDataMisuseRule.BAD_FOR_STACK_CHILD), 'Stack');
        return [...flex, ...stack];
    }
}

/**
 * R-FLUTTER-UNBOUNDED-SCROLLABLE: a ListView/GridView/CustomScrollView/
 * PageView placed directly in a Row/Column/Flex where the viewport certainly
 * throws "… viewport was given unbounded height/width" — a Flex gives
 * non-flexible children an unbounded main axis (see `viewportThrows`).
 * 1.1.0: decided on the `shrinkWrap`/`scrollDirection` VALUES, not on the
 * arguments' presence (`shrinkWrap: false` is reported; a cross-axis
 * scrollable is reported even with `shrinkWrap: true`; unknown values that
 * matter keep it silent).
 */
export class FlutterUnboundedScrollableRule extends FlutterLayoutRule {
    public readonly id = 'R-FLUTTER-UNBOUNDED-SCROLLABLE';
    public override readonly version = '1.3.0';
    protected readonly text: LayoutRuleText = {
        statement: {
            en: '{child} is placed directly in {parent}.{slot} without Expanded/Flexible/SizedBox, so its viewport gets an unbounded extent.',
            de: '{child} steht direkt in {parent}.{slot}, ohne Expanded/Flexible/SizedBox, sodass sein Viewport eine unbegrenzte Ausdehnung bekommt.'
        },
        suggestion: {
            en: 'Wrap {child} in Expanded (or Flexible) to give it the remaining space, or in a SizedBox with a fixed extent.',
            de: '{child} in Expanded (oder Flexible) setzen, damit es den restlichen Platz bekommt, oder in eine SizedBox mit fester Ausdehnung.'
        },
        drawbacks: {
            en: 'shrinkWrap: true would also silence the error but lays out every item eagerly; prefer Expanded for long lists.',
            de: 'shrinkWrap: true beseitigt den Fehler ebenfalls, legt aber alle Einträge sofort an; für lange Listen Expanded bevorzugen.'
        },
        missingContext: withIdentity({
            en: 'Only the direct (structural) parent is checked; a scrollable reaching the Flex through a helper method, variable or builder is not seen. shrinkWrap/scrollDirection/direction are read as literals (absent = framework default); a variable or expression there keeps the rule silent unless the other values already make the error certain.',
            de: 'Geprüft wird nur der direkte (strukturelle) Elternknoten; ein Scrollable, das über eine Hilfsmethode, Variable oder einen Builder in den Flex gelangt, wird nicht gesehen. shrinkWrap/scrollDirection/direction werden als Literale gelesen (fehlend = Framework-Standard); eine Variable oder ein Ausdruck dort hält die Regel still, außer die übrigen Werte machen den Fehler bereits sicher.'
        }),
        rationale: {
            en: 'A scrollable viewport needs a bounded extent, but a Row/Column gives its non-flexible children an unbounded main axis; the declared layout cannot be satisfied and Flutter throws at runtime (marcus.judgment).',
            de: 'Ein scrollbarer Viewport braucht eine begrenzte Ausdehnung, aber eine Row/Column gibt nicht-flexiblen Kindern eine unbegrenzte Hauptachse; das deklarierte Layout ist nicht erfüllbar und Flutter wirft zur Laufzeit (marcus.judgment).'
        }
    };

    protected matches(index: WidgetGraphIndex): Match[] {
        return collect(
            index,
            SCROLLABLES,
            (child, parent, slot) => slot === 'children' && isFlutterWidget(parent, FLEX)
        ).flatMap((match) => {
            const verdict = viewportThrows(match.child, flexAxis(match.parent));
            return verdict.throws ? [{...match, detail: verdict.detail}] : [];
        });
    }
}

/**
 * R-FLUTTER-TEXTFIELD-UNBOUNDED-WIDTH: a TextField/TextFormField placed
 * directly in a Row — the InputDecorator gets an unbounded width and throws
 * "An InputDecorator … cannot have an unbounded width".
 */
export class FlutterTextFieldInRowRule extends FlutterLayoutRule {
    public readonly id = 'R-FLUTTER-TEXTFIELD-UNBOUNDED-WIDTH';
    private static readonly ROW = new Set(['Row']);
    protected readonly text: LayoutRuleText = {
        statement: {en: '{child} is placed directly in {parent}.{slot} without Expanded/Flexible/SizedBox.', de: '{child} steht direkt in {parent}.{slot}, ohne Expanded/Flexible/SizedBox.'},
        suggestion: {
            en: 'Wrap {child} in Expanded (or Flexible), or give it a fixed width with SizedBox.',
            de: '{child} in Expanded (oder Flexible) setzen oder ihm mit SizedBox eine feste Breite geben.'
        },
        drawbacks: {en: 'None of note; the current layout throws at runtime.', de: 'Keine nennenswerten; das jetzige Layout wirft zur Laufzeit.'},
        missingContext: withIdentity({
            en: 'A decoration with explicit width constraints (InputDecoration.constraints) is not evaluated; a Flex with a runtime direction is not checked.',
            de: 'Eine Dekoration mit expliziten Breiten-Constraints (InputDecoration.constraints) wird nicht ausgewertet; ein Flex mit Laufzeit-Richtung wird nicht geprüft.'
        }),
        rationale: {
            en: 'A text field sizes itself to the width it is given, but a Row gives non-flexible children an unbounded width; the declared layout cannot be satisfied and Flutter throws at runtime (marcus.judgment).',
            de: 'Ein Textfeld nimmt die Breite an, die es bekommt, aber eine Row gibt nicht-flexiblen Kindern eine unbegrenzte Breite; das deklarierte Layout ist nicht erfüllbar und Flutter wirft zur Laufzeit (marcus.judgment).'
        }
    };

    protected matches(index: WidgetGraphIndex): Match[] {
        return collect(index, TEXT_FIELDS, (_child, parent, slot) => slot === 'children' && isFlutterWidget(parent, FlutterTextFieldInRowRule.ROW));
    }
}

/**
 * R-FLUTTER-NESTED-SCROLL-UNBOUNDED: a ListView/GridView/CustomScrollView/
 * ReorderableListView placed directly in a SingleChildScrollView or ListView
 * where the inner viewport certainly throws — the outer scroller leaves its
 * own scroll axis unbounded (see `viewportThrows`).
 * 1.1.0: decided on the `scrollDirection`/`shrinkWrap` VALUES of both (absent
 * = default vertical / false); previously any written `scrollDirection` or
 * `shrinkWrap` silenced it.
 */
export class FlutterNestedScrollRule extends FlutterLayoutRule {
    public readonly id = 'R-FLUTTER-NESTED-SCROLL-UNBOUNDED';
    public override readonly version = '1.3.0';
    protected override readonly confidence = 0.75;
    protected readonly text: LayoutRuleText = {
        statement: {
            en: '{child} is placed directly in the scroller {parent}.{slot} without a bounded size, so its viewport gets an unbounded extent.',
            de: '{child} steht direkt im Scroller {parent}.{slot}, ohne begrenzte Größe, sodass sein Viewport eine unbegrenzte Ausdehnung bekommt.'
        },
        suggestion: {
            en: 'Merge both lists into one scrollable (e.g. a CustomScrollView with slivers), or give {child} a fixed height with SizedBox.',
            de: 'Beide Listen zu einem Scrollable zusammenführen (z. B. CustomScrollView mit Slivers) oder {child} mit SizedBox eine feste Höhe geben.'
        },
        drawbacks: {
            en: 'shrinkWrap: true plus NeverScrollableScrollPhysics also works but lays out every item eagerly.',
            de: 'shrinkWrap: true plus NeverScrollableScrollPhysics funktioniert auch, legt aber alle Einträge sofort an.'
        },
        missingContext: withIdentity({
            en: 'scrollDirection and shrinkWrap are read as literals on both widgets (absent = default vertical / false); a variable or expression there keeps the rule silent unless the other values already make the error certain.',
            de: 'scrollDirection und shrinkWrap werden an beiden Widgets als Literale gelesen (fehlend = Standard vertikal / false); eine Variable oder ein Ausdruck dort hält die Regel still, außer die übrigen Werte machen den Fehler bereits sicher.'
        }),
        rationale: {
            en: 'An inner scrollable needs a bounded extent, but a scroller gives its content an unbounded one along its scroll axis; the declared layout cannot be satisfied and Flutter throws at runtime (marcus.judgment).',
            de: 'Ein inneres Scrollable braucht eine begrenzte Ausdehnung, aber ein Scroller gibt seinem Inhalt entlang seiner Scrollachse eine unbegrenzte; das deklarierte Layout ist nicht erfüllbar und Flutter wirft zur Laufzeit (marcus.judgment).'
        }
    };

    protected matches(index: WidgetGraphIndex): Match[] {
        return collect(
            index,
            SHRINKABLE_SCROLLABLES,
            (_child, parent, slot) => isFlutterWidget(parent, OUTER_SCROLLERS) && parent.constructorName === null && (slot === 'child' || slot === 'children')
        ).flatMap((match) => {
            const verdict = viewportThrows(match.child, scrollAxis(match.parent));
            return verdict.throws ? [{...match, detail: verdict.detail}] : [];
        });
    }
}

/** The Flutter layout rules, in a fixed order (findings are sorted by the engine anyway). */
export const flutterLayoutRules = (): ProjectRule[] => [new FlutterParentDataMisuseRule(), new FlutterUnboundedScrollableRule(), new FlutterTextFieldInRowRule(), new FlutterNestedScrollRule()];

export const resolvePrinciple = (knowledgeBase: KnowledgeBase, lang: string, rationale: string, principleId: string = PRINCIPLE_ID): PrincipleInterpretationRef[] => {
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
            rationale
        }
    ];
};
