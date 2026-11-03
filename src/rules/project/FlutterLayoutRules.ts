import type {Finding, PrincipleInterpretationRef} from '../../Types.js';
import {localize, type LocalizedText} from '../../i18n/Localized.js';
import type {KnowledgeBase} from '../../knowledge/KnowledgeBase.js';
import type {FlutterWidgetGraph, WidgetEdge, WidgetNode} from '../../model/FlutterWidgetGraph.js';
import type {ProjectRule, ProjectRuleInput} from '../ProjectRule.js';

/**
 * Flutter layout rules (Flutter Phase 2) — the first consumers of the
 * FlutterWidgetGraph. Each one reports a parent/child combination the Flutter
 * framework rejects at RUNTIME with a layout exception (red error screen in
 * debug, a grey box in release), which `flutter analyze` does not report.
 *
 * Shared, deliberately conservative discipline:
 * - IDENTITY: a widget counts as the Flutter widget of that name only when the
 *   graph grades it `heuristic` with at least one `package:flutter/` import
 *   candidate. A same-file declaration of that name (`verified`/`local`)
 *   shadows the framework class; no Flutter import means no claim at all.
 * - STRUCTURE: the effective parent is found by walking up through the
 *   transparent nodes only (`conditional`, `repeat`, `spread`, `list` — they
 *   place their elements into the same slot). A `builder`, `reference`,
 *   `dynamic` or `unparsed` node on the way, a root, or a non-`known` status
 *   ends the walk WITHOUT a finding: the real parent is not known.
 * - PARENT SETS are curated allowlists of framework widgets whose behaviour
 *   for that slot is fixed. An unknown/custom parent is never assumed to be
 *   wrong (a StatelessWidget wrapper may legitimately pass the child through).
 * - ARGUMENT VALUES are not in the graph (names only): a rule that depends on
 *   one (e.g. `scrollDirection`) stays silent when the argument is present.
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
    node.identity !== null &&
    node.identity.status === 'heuristic' &&
    node.identity.candidates.some((candidate) => candidate.startsWith(FLUTTER_PACKAGE));

const displayName = (node: WidgetNode): string => `${node.name ?? '?'}${node.constructorName === null ? '' : `.${node.constructorName}`}`;

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
const TEXT_FIELDS = new Set(['TextField', 'TextFormField']);
const VERTICAL_OUTER_SCROLLERS = new Set(['SingleChildScrollView', 'ListView']);

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
}

/** Common finding assembly for the layout rules; subclasses only find matches. */
abstract class FlutterLayoutRule implements ProjectRule {
    public abstract readonly id: string;
    public readonly version = '1.0.0';
    public readonly requiredFactKinds = ['ui.flutterWidgetTree', 'dart.classDecl', 'dart.importSpec'];
    protected abstract readonly text: LayoutRuleText;
    protected readonly confidence: number = 0.8;

    protected abstract matches(index: WidgetGraphIndex): Match[];

    public evaluate(input: ProjectRuleInput): Finding[] {
        if (input.flutterWidgetGraph === undefined || input.flutterWidgetGraph.nodes.length === 0) {
            return [];
        }
        const index = new WidgetGraphIndex(input.flutterWidgetGraph);
        return this.matches(index).map((match) => this.buildFinding(match, input));
    }

    private buildFinding(match: Match, input: ProjectRuleInput): Finding {
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
            location: {file: child.file, range: child.range, symbol: child.owner.slice(0, child.owner.lastIndexOf('@')), structure: 'widget'},
            observation: {
                statement: fill(this.text.statement),
                evidence: [{fact: 'ui.flutterWidgetTree', value: `${displayName(parent)}.${slot} > ${displayName(child)}`, certainty: 'syntactic'}]
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
    en: 'Widgets are identified by name plus a package:flutter import in the same file (no type resolution); a project class re-using a framework name and imported from elsewhere could make this a false positive.',
    de: 'Widgets werden über den Namen plus einen package:flutter-Import in derselben Datei erkannt (keine Typauflösung); eine anderswo importierte Projektklasse mit einem Framework-Namen kann einen Fehlalarm bedeuten.'
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
 * PageView placed directly in a Row/Column/Flex without `shrinkWrap` — a
 * Flex gives non-flexible children an unbounded main axis, so the viewport
 * throws "… viewport was given unbounded height/width".
 */
export class FlutterUnboundedScrollableRule extends FlutterLayoutRule {
    public readonly id = 'R-FLUTTER-UNBOUNDED-SCROLLABLE';
    protected readonly text: LayoutRuleText = {
        statement: {
            en: '{child} is placed directly in {parent}.{slot} without Expanded/Flexible/SizedBox and without shrinkWrap.',
            de: '{child} steht direkt in {parent}.{slot}, ohne Expanded/Flexible/SizedBox und ohne shrinkWrap.'
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
            en: 'Only the direct (structural) parent is checked; a scrollable reaching the Flex through a helper method, variable or builder is not seen.',
            de: 'Geprüft wird nur der direkte (strukturelle) Elternknoten; ein Scrollable, das über eine Hilfsmethode, Variable oder einen Builder in den Flex gelangt, wird nicht gesehen.'
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
            (child, parent, slot) => slot === 'children' && isFlutterWidget(parent, FLEX) && !(SHRINKABLE_SCROLLABLES.has(child.name ?? '') && child.argNames.includes('shrinkWrap'))
        );
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
 * R-FLUTTER-NESTED-SCROLL-UNBOUNDED: a vertical ListView/GridView/
 * CustomScrollView placed directly in a vertical SingleChildScrollView or
 * ListView without `shrinkWrap` — the outer scroller gives an unbounded
 * height. The axis is inferred from the ABSENCE of `scrollDirection` on both
 * (its value is not in the graph); either one carrying it is not reported.
 */
export class FlutterNestedScrollRule extends FlutterLayoutRule {
    public readonly id = 'R-FLUTTER-NESTED-SCROLL-UNBOUNDED';
    protected override readonly confidence = 0.75;
    protected readonly text: LayoutRuleText = {
        statement: {
            en: '{child} is placed directly in the vertical scroller {parent}.{slot} without shrinkWrap or a bounded height.',
            de: '{child} steht direkt im vertikalen Scroller {parent}.{slot}, ohne shrinkWrap oder begrenzte Höhe.'
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
            en: 'Both scroll directions are inferred from the absence of a scrollDirection argument (default vertical); argument values are not evaluated.',
            de: 'Beide Scrollrichtungen werden aus dem Fehlen eines scrollDirection-Arguments abgeleitet (Standard vertikal); Argumentwerte werden nicht ausgewertet.'
        }),
        rationale: {
            en: 'An inner scrollable needs a bounded height, but a vertical scroller gives its content an unbounded one; the declared layout cannot be satisfied and Flutter throws at runtime (marcus.judgment).',
            de: 'Ein inneres Scrollable braucht eine begrenzte Höhe, aber ein vertikaler Scroller gibt seinem Inhalt eine unbegrenzte; das deklarierte Layout ist nicht erfüllbar und Flutter wirft zur Laufzeit (marcus.judgment).'
        }
    };

    protected matches(index: WidgetGraphIndex): Match[] {
        return collect(
            index,
            SHRINKABLE_SCROLLABLES,
            (child, parent, slot) =>
                isFlutterWidget(parent, VERTICAL_OUTER_SCROLLERS) &&
                parent.constructorName === null &&
                (slot === 'child' || slot === 'children') &&
                !parent.argNames.includes('scrollDirection') &&
                !child.argNames.includes('scrollDirection') &&
                !child.argNames.includes('shrinkWrap')
        );
    }
}

/** The Flutter layout rules, in a fixed order (findings are sorted by the engine anyway). */
export const flutterLayoutRules = (): ProjectRule[] => [new FlutterParentDataMisuseRule(), new FlutterUnboundedScrollableRule(), new FlutterTextFieldInRowRule(), new FlutterNestedScrollRule()];

const resolvePrinciple = (knowledgeBase: KnowledgeBase, lang: string, rationale: string): PrincipleInterpretationRef[] => {
    const principle = knowledgeBase.get(PRINCIPLE_ID);
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
