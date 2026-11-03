# SOLID as an analysis area – feasibility analysis (Flutter quality track, Phase D)

> Status: **analysis, no implementation.** There is no `R-SOLID-*` rule.
> It is based on the code state after Phase C and on measurements with a throwaway prototype.
> The prototype ran on four real Flutter apps (swipemeister, mwpa-app, velyo,
> movinder) and on two TypeScript code bases (stoa/src, flyingfish/backend).
> It is not part of the repository. German version: [../de/solid-feasibility.md](../de/solid-feasibility.md).

## 0. Summary

- **SOLID fits as a rule area of its own, but not as a knowledge base of its own.**
  - The five principles map completely onto existing principles:
    `marcus.purpose` (cohesion, "single responsibility"), `marcus.cooperation`
    (dependency direction), `marcus.judgment` (declaration = behaviour) and
    `marcus.simplicity`.
  - They also map onto existing dimensions: `responsibility-boundaries` and `dependencies`.
  - An `R-SOLID-*` area is therefore a rule family, not a new foundation.
- **The central gap is the class model.**
  - No language provides facts about class members today: methods, fields,
    constructor parameters with types, overrides, or accesses between members.
  - Only Dart has type declarations (`dart.classDecl`: supertype, mixins, interfaces, abstract).
  - `deps.export` (TS) knows only the name, not the kind of declaration.
  - Dart is missing from the ModuleGraph because it emits no `deps.import` facts.
- **The data is sobering for the "classic" signals.**
  - LCOM cohesion, type dispatch and service-name patterns produced almost only
    artefacts or legitimate patterns on the six code bases.
  - Precise signals such as degenerate overrides or a data-access dependency in
    UI files are rare but reliable.
- **Recommended order for Phase E** (rationale in §7):
  1. **DIP layer:** a UI unit depends directly on data access or I/O.
     Proven via a declared layer assignment (R6) or via package classification.
  2. **LSP/ISP contract:** an override throws `UnsupportedError`/`UnimplementedError`
     or `Error('not implemented')`, or is empty, against a project abstract declaration.
  3. **SRP cohesion:** only as an experimental hint, and only after the class model and calibration (OQ-6).
  4. **OCP:** no rule for now.
  5. **DIP via concrete constructor types:** no rule; at most a metric or evidence.

## 1. What is available today

| Source | TS | PHP | Dart | C/C++ | Usable for SOLID |
|---|---|---|---|---|---|
| `deps.import`/`deps.importName`/`deps.export` | yes | import yes | – (own `dart.importSpec`) | – | DIP direction (module level) |
| ModuleGraph (Phase 0) | yes | yes | **no** | no | cycles, layer direction |
| SymbolGraph (Phase 1) | yes | – | no | no | which binding goes where; **no** declaration kind |
| DartLibraryIndex (Phase B) | – | – | yes | – | identity "framework vs. project vs. ambiguous" |
| `dart.classDecl` | – | – | yes | – | hierarchy, `abstract`, interfaces |
| `metric.*` (function length, complexity, parameter count) | yes | yes | yes | yes | size only, no structural understanding |
| FlutterWidgetGraph | – | – | yes | – | UI structure, not architecture |
| `dart.stateLifecycle` | – | – | yes | – | fields and creations of a State (State classes only) |
| Type information | ts-morph type checker (present in the extractor) | – | – | – | interface vs. class resolvable, if tsconfig/paths resolve |

**Every** SOLID principle lacks a neutral **class/member model**. Per type
declaration it would need to hold:

- kind (class, abstract, interface, mixin, enum) and supertypes;
- members with name, kind, override marker and body shape (empty, throws
  "unsupported", abstract, normal);
- fields with declared type, and constructor parameters with type;
- for each method, the set of own members it references.

## 2. Measurements (prototype, not in the repo)

The prototype uses tree-sitter-dart or ts-morph, the same parsers as stoa. It measures the signals the specification suggests.

| Signal | Dart: 4 apps (326 files, 640 classes) | TS: stoa/src (33 classes) + flyingfish/backend (214 classes) |
|---|---|---|
| Classes with a parse error in the body (Dart 3) | 13 (2 %; velyo 11/202 = 5 %) | – |
| Classes with ≥ 8 methods | 55 | 3 + 8 |
| … of which LCOM4 has ≥ 2 non-trivial components | 14 | 0 + 0 |
| UI classes in files importing data access (`http`, `dio`, `shared_preferences`, `sqflite`, `cloud_firestore`, …) | 8 of 362 (all in mwpa-app, `shared_preferences`) | – |
| Constructor/field types: project-abstract / project-concrete / external | 3 / 214 / 1638 | interface 4 / concrete 4 / unknown 13 |
| `new` or constructor call of a project "service" (name pattern) | 25 | 7 |
| Static singleton access `X.instance` | 112 | – |
| Abstract project classes / interfaces | 6 (constant containers, localization) | 139 (stoa) / 6 (flyingfish) |
| Empty or "unsupported"-throwing overrides | 0 | 0 |
| Type dispatch (`is`/`instanceof` chain ≥ 3, `switch (x.runtimeType)`) | 1 | 0 |

What the hits actually are (checked by hand):

- **LCOM4 (14 hits):**
  - 13 are State classes of the swipemeister avatar animations. The split runs
    through framework lifecycle members (`initState`/`dispose`/`didUpdateWidget`,
    the mixin getter `animate`) and through inherited members (`widget`, mixin
    methods). These are **artefacts** of a model without inherited members.
  - The 14th hit (`DynInputValue`) is a value holder with typed accessors per
    variant. That is closer to a union type than an SRP violation, so it is ambiguous.
- **Type dispatch (1 hit):** `ApiService._logError` distinguishes exception types
  (`SocketException`, `TimeoutException`, …). That is a closed, external set and
  **legitimate**, not an OCP violation.
- **"Service" instantiation:**
  - In swipemeister, `Provider` is a **data model** (`Model/Provider.dart`).
    Name patterns are unreliable.
  - The 7 TS hits in flyingfish are **self-instantiating singletons**
    (`getInstance()`), a pattern rather than a foreign dependency.
- **Singletons** (`ContentRepository.instance`, `Audio.instance`,
  `ConnectivityBus.instance`): this is the dominant dependency style of the apps.
  Framework singletons (`WidgetsBinding.instance`) are counted too; only identity
  resolution (Phase B) would separate them.
- **Abstractions are almost entirely absent from the apps.** A rule "depends on a
  concrete type" would flag practically every dependency there. That would be a
  blanket judgement, which spec §8 explicitly rules out.

Conclusion: size and name metrics do not produce architectural understanding (§8). Only signals tied to a **provable structure** are reliable: a contract, a layer, an identity.

## 3. The five principles one by one

### 3.1 SRP – `R-SOLID-SRP-RESPONSIBILITY-COHESION`

- **Signals:**
  - methods splitting into independent groups (shared fields or calls, LCOM4);
  - disjoint dependency groups (group A uses only network imports, group B only UI);
  - a mix of UI, data access and business logic in one class.
- **Needs:**
  - the class/member model with member→member and member→import references;
  - additionally, knowledge of **inherited and framework members**: `widget`,
    `context`, `setState`, lifecycle hooks and mixin contracts must be taken out of
    the cohesion computation, or counted as links.
- **Limits:**
  - Cohesion through conventions (lifecycle, mixins, callbacks in `build`) is only
    statically visible with framework knowledge.
  - Dynamic access (reflection, `noSuchMethod`) is not visible.
  - Dart 3 syntax cannot be parsed by tree-sitter-dart 1.0 (2–5 % of classes).
- **False-positive risk: high.** 13 of 14 measured hits were artefacts. Size alone is not a finding (spec).
- **Verdict: conditionally feasible.**
  - Only as an `info` hint with `semantic-heuristic`, confidence ≤ 0.5 and experimental status.
  - The evidence must name the groups (methods + fields + imports per group), not a number.
  - Calibration on the corpus is a prerequisite (open question OQ-6).

### 3.2 OCP – `R-SOLID-OCP-EXTENSION-COUPLING`

- **Signals:**
  - repeated type dispatch over the same **own, open** hierarchy in several places;
  - central registries or factories that must change for every extension.
- **Needs:**
  - the type hierarchy (present for Dart, via ts-morph for TS);
  - dispatch facts (`is`/`instanceof`/`switch` on a type or `runtimeType`);
  - for "repeated modification", the git history (baseline/temporal support is only rudimentary).
- **Limits:**
  - In Dart 3, `sealed` hierarchies with an exhaustive `switch` are the
    **idiomatic, compiler-checked** pattern. Dispatch is not an OCP problem there.
  - This is exactly the syntax tree-sitter-dart 1.0 cannot parse.
  - Dispatch over external closed sets (exceptions, enums) is legitimate.
  - The orientation article itself uses an `is` chain in its OCP example.
- **False-positive risk: very high.** The only measured hit was legitimate.
- **Verdict: not reliable at present.** At most later: the same open project
  hierarchy is dispatched by type chains in ≥ 2 places and is **not** `sealed`.

### 3.3 LSP – `R-SOLID-LSP-CONTRACT-COMPATIBILITY`

- **Statically detectable:**
  - an override that refuses the inherited behaviour: it throws
    `UnsupportedError`/`UnimplementedError` or `new Error('not implemented')`, or it
    is empty while the base is not a no-op;
  - in Dart, `covariant` parameters (a deliberate narrowing of the parameter type);
  - in TS, overrides that replace a base method with a narrower parameter union
    (needs the type checker).
- **Not statically detectable:** changed pre- and postconditions, violated
  invariants, "unexpected" exceptions beyond these patterns. That would need
  contracts, tests or dataflow.
- **Needs:** the member model with the override link and body shape, plus the
  base's identity (project vs. framework, via DartLibraryIndex or SymbolGraph).
- **False-positive risk: low for the body patterns; 0 hits measured.**
  - Exceptions: framework hooks whose base is a no-op (`dispose`, `didUpdateWidget`), and test doubles.
  - An empty override of an *abstract* method is not an LSP violation but a no-op
    implementation (an ISP hint, see 3.4).
- **Verdict: feasible, but rare.** A precise rule with small reach.
  "Inheritance or overriding is a problem" is explicitly not checked.

### 3.4 ISP – `R-SOLID-ISP-INTERFACE-COHESION`

- **Signals:**
  - implementations that fulfil parts of an interface as "unsupported" or empty;
    this is the *reliable* core;
  - clients that use only a small, stable subset of a wide interface (usage
    analysis via SymbolGraph and member accesses).
- **Limits:**
  - Member access through variables needs type resolution. That is feasible for TS
    via ts-morph, but only syntactic for Dart (no type checker).
  - "Large" alone is not a finding. stoa itself has 139 interfaces (p90 = 9 members),
    mostly data and fact shapes.
- **False-positive risk:**
  - low for degenerate implementations of a **project** interface;
  - high for usage breadth: data types are rarely read in full.
- **Verdict:** degenerate implementation is feasible and shares its facts with 3.3.
  Usage breadth only makes sense after type resolution.

### 3.5 DIP – `R-SOLID-DIP-CONCRETE-DEPENDENCY`

- **Signals (assessed separately):**
  - **Layer direction:** UI (widget, State, page) depends directly on data access
    or I/O, i.e. on packages such as `http`/`dio`/`shared_preferences`/`sqflite`/
    `cloud_firestore`, or on project modules of the data layer.
  - **Self-creation:** UI creates a project service itself (`MwpaApi()` in
    `_LoginPageState`) or accesses a singleton (`X.instance`).
  - **Concrete types:** constructor and field types are concrete project classes instead of abstractions.
- **Distinction per dependency:**
  - *abstraction*: interface, abstract class, type parameter;
  - *concrete*: non-abstract project class;
  - *dynamic or unknown*: unresolved type, `dynamic`, external type without
    knowledge, result of a DI container (`GetIt.I<T>()`, `context.read<T>()`). This case is never reported.
- **Needs:**
  - Dart in the ModuleGraph (from `dart.importSpec` + DartLibraryIndex; missing today);
  - a **layer assignment**: declared via R6 (architecture config, already on the
    roadmap) or classified via packages (data-access packages, Flutter UI identity);
  - identity of the instantiated or referenced types (Phase B).
- **False-positive risk:**
  - Layer direction with a declaration: **low**, because violating a *declared*
    rule is provable (cf. `R-DEP-CYCLE`).
  - Layer direction via package classification: **medium**, measured at 8 UI classes in one app.
    Small apps access data directly on purpose; the finding is a hint, not an error.
  - Self-creation: **medium**. The singleton pattern and data models with service-like
    names are common; it is only viable with identity (project class, not abstract)
    and without name patterns.
  - Concrete constructor types: **high**. In apps without abstractions it hits everything.
- **Verdict:**
  - Layer direction: **the most feasible**; certain with a declaration, a hint without one.
  - Self-creation: conditionally feasible.
  - Concrete types: no rule.

## 4. SOLID and Flutter (§7)

- The **FlutterWidgetGraph stays UI structure.** Architectural information does not
  belong in it. Instead, Flutter provides *additional evidence* through existing sources:
  - **UI identity of a class** (`extends State`/`StatelessWidget`/`StatefulWidget`,
    resolved via DartLibraryIndex): assigns classes to the UI layer (DIP layer, SRP groups).
  - **`build()` content:** calls that create no widgets (network, DB, computation).
    A small separate fact per `build` is enough; the widget graph does not carry this.
  - **`dart.stateLifecycle`:** it knows a State's fields and creations and can be
    reused for "creates its own services".
- The §7 examples mapped:

  | §7 example | Mapping |
  |---|---|
  | widgets with UI + data access | DIP layer |
  | large State classes | SRP cohesion, only with lifecycle knowledge |
  | business logic in `build` | SRP Flutter evidence |
  | widgets creating services | DIP self-creation |
  | wide dependencies | ISP usage, later |
  | interchangeable widgets | LSP, rarely relevant |

- **Cross-language:** the rules evaluate only the neutral class model and
  ModuleGraph/SymbolGraph. Flutter, Angular or React contribute only the
  "UI" layer assignment and framework members, through their adapters.

## 5. Concept: SOLID as a cross-language area

1. **Facts (per adapter, file-local, cacheable):** `struct.typeDecl` (kind,
   supertypes, abstract) and `struct.member` (kind, override, body shape, declared
   type, referenced own members, referenced import bindings).
   - Dart: an extension of the declaration facts (`dart.classDecl` stays).
   - TS: ts-morph. PHP and C++: tree-sitter, later.
   - Like all facts, they are neutral and carry no judgement.
2. **Model (after extraction, from facts only, like ModuleGraph/SymbolGraph):** a
   `TypeModel` with the hierarchy, supertypes resolved via SymbolGraph or
   DartLibraryIndex, and members including inherited members where they are
   project declarations. Unknown supertypes stay unknown.
3. **Layers:** declared via the planned architecture config (R6).
   Without a config, only package-based hints.
4. **Rules:** `R-SOLID-*` as project rules, with principles and dimensions from the existing set:

   | Rule | Principle | Dimension |
   |---|---|---|
   | SRP | `marcus.purpose` | `responsibility-boundaries` |
   | DIP | `marcus.cooperation` (+ `marcus.control` for I/O in UI) | `dependencies` |
   | LSP | `marcus.judgment` | `responsibility-boundaries` |
   | ISP | `marcus.purpose` | `responsibility-boundaries` |

5. **Certainty levels:**
   - `syntactic`: only for violations of something *declared* (layer config) and for
     degenerate overrides against project abstractions;
   - `semantic-heuristic` with confidence ≤ 0.6: everything else;
   - severity at most `low`, except for declared layer violations (`medium`).

## 6. Rule architecture: certain vs. heuristic (§8)

- **Present:**
  - `Certainty` (`syntactic` | `semantic-heuristic` | `external-tool`);
  - separate `severity` and `confidence`;
  - `certaintyBasis` on the finding;
  - a confidence cap by certainty for **declarative** rules (`capBy: certainty`,
    heuristic ≤ 0.6);
  - `missingContext` for detection limits.
- **Gaps** (finding only; not changed in Phase D):
  - Project rules set `certaintyBasis` and `confidence` themselves, **without** a
    central cap. Example: `R-VALIDATION-CONTRACT-MISMATCH` reports
    `semantic-heuristic` at 0.7, above the 0.6 cap of declarative rules.
  - There is no "experimental" rule status. Mitigation R-2 in open-questions names
    it, but it does not exist.
  - The CLI cannot filter by certainty or confidence.
  - For a heuristic SOLID area these three points are a prerequisite; otherwise
    SOLID hints mix with certain findings.

## 7. Prioritisation (recommendation for Phase E)

| Rank | Rule (variant) | Reliability | Value | Prerequisites |
|---|---|---|---|---|
| 1 | DIP layer: UI → data access or I/O | high with an R6 config, medium without | high (most frequent structural flaw in Flutter apps) | Dart in the ModuleGraph, layer classification, R6 |
| 2 | LSP/ISP: degenerate override or implementation against a project abstraction | high | low to medium (rare) | `struct.typeDecl`/`struct.member`, TypeModel |
| 3 | DIP self-creation: UI creates a project service or accesses a singleton | medium | medium | as 2 + identity; pattern exceptions (singleton factory, data models) |
| 4 | SRP cohesion (experimental) | low to medium | medium | as 2 + inherited and framework members, OQ-6 calibration, "experimental" rule status |
| – | OCP dispatch | low | low | Dart 3 parser, history |
| – | DIP concrete types | low (blanket) | low | metric only |

Cross-cutting groundwork without which no SOLID rule makes sense:

- Dart in the ModuleGraph;
- the neutral class model;
- a confidence cap for project rules too;
- an "experimental" rule status or a CLI filter.

## 8. Designed test cases (proof of feasibility)

Expectation: **R** = report, **S** = silent. Each later rule gets these cases as fixtures.

| Principle | Case | Expectation |
|---|---|---|
| DIP layer | `_LoginPageState` imports `package:http/http.dart` and calls `http.post` | R (hint; with an R6 config: violation) |
| DIP layer | a page receives an `AuthRepository` (abstract) via its constructor | S |
| DIP layer | a page reads `context.read<AuthRepository>()` or `GetIt.I<…>()` | S (dependency dynamic, unknown) |
| DIP layer | a file without a UI class imports `dio` | S |
| DIP self-creation | a `State` creates `MwpaApi()` (concrete project class) | R |
| DIP self-creation | a `State` creates `Provider(...)`, a data-model class (no resource, no I/O) | S (no name pattern) |
| DIP self-creation | `class S { static final instance = S(); }`: self-singleton | S |
| DIP self-creation | ambiguous identity of the created type (Phase B) | S |
| LSP | `class Fast extends Cache { @override void put(k, v) => throw UnsupportedError('…'); }`, `Cache.put` concrete | R |
| LSP | an override throws `ArgumentError` after validation | S |
| LSP/ISP | `class Mock implements Repo { @override Future<void> sync() async {} }`, `Repo.sync` abstract | S for LSP; ISP hint only if ≥ 2 members are degenerate |
| LSP | `@override void dispose() {}` in a State subclass (framework no-op base) | S |
| ISP | `implements Printer, Scanner`: all members implemented | S |
| ISP | `implements Device` with 3 of 5 members throwing `UnimplementedError` | R |
| SRP | a class with two method groups using disjoint fields **and** disjoint import groups (network vs. formatting) | R (experimental, groups as evidence) |
| SRP | a State class whose groups are linked only via `widget`/lifecycle/mixin | S |
| SRP | a value holder with accessor pairs per variant (`DynInputValue`) | S |
| SRP | a large class with one connected group | S (size is not a finding) |
| OCP | `if (e is SocketException) … else if (e is TimeoutException) …` | S (external, closed set) |
| OCP | `switch (shape) { case Circle(): … }` over `sealed` | S (and: Dart 3 not parseable → unknown) |
| all | a class with a parse error in its body | S, with a coverage note |

## 9. Detection limits and open decisions (for Phase E)

- **Parser:** tree-sitter-dart 1.0 does not know Dart 3 (sealed, patterns, records,
  switch expressions). OCP and parts of SRP are therefore incomplete for modern Dart
  code bases. A grammar update would be a separate dependency change that needs justification.
- **Type information:** stoa has no Dart type checker. ISP usage breadth and DIP
  through variables stay syntactically limited for Dart.
- **History:** "repeated modification" (OCP, SRP) needs git history, which is not in the fact model.
- **To decide:**
  1. Should rank 1 wait for R6 (declared layers), or come first as a hint via
     package classification?
  2. Should SOLID rules be active by default or opt-in (like `--dead-exports`)?
  3. Should an "experimental" rule status or a confidence filter be part of Phase E?
