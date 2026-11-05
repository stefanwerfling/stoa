import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ModuleResolver} from '../src/analysis/ModuleResolution.js';
import {EMPTY_PROJECT_CONFIG, loadProjectConfig} from '../src/config/ProjectConfig.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {buildModuleGraph, cycleAdjacency, type ModuleGraph} from '../src/model/ModuleGraph.js';
import {buildTypeModel} from '../src/model/TypeModel.js';
import {analyze} from '../src/Pipeline.js';

// Identity spec, phase 4: PHP `use` resolves through the root composer.json's
// PSR-4 mappings — in Composer's order, against the analyzed files — and an
// unresolved name is classified only as far as the mappings say (external
// outside every prefix, a project reference under one, unknown without a
// composer.json).

const testDir = dirname(fileURLToPath(import.meta.url));

const withProject = (files: Record<string, string>, run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'stoa-psr4-'));
    try {
        for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, path)), {recursive: true});
            writeFileSync(join(dir, path), content);
        }
        run(dir);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
};

const graphOf = (dir: string): {graph: ModuleGraph; rules: string[]} => {
    const result = analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config: DEFAULT_CONFIG});
    const files = new Set(result.facts.map((fact) => fact.subject.file));
    return {graph: buildModuleGraph(result.facts, files, new ModuleResolver(loadProjectConfig(dir))), rules: result.report.findings.map((finding) => finding.rule.id)};
};

const COMPOSER = JSON.stringify({autoload: {'psr-4': {'App\\': 'src/'}}});
const REPO = '<?php\nnamespace App\\Repo;\nuse App\\Service\\UserService;\nclass UserRepo { public function x(UserService $s) {} }\n';
const SERVICE =
    '<?php\nnamespace App\\Service;\nuse App\\Repo\\UserRepo;\nuse Psr\\Log\\LoggerInterface;\nuse App\\Missing\\Gone;\nuse function App\\Support\\helper;\n' +
    'class UserService { public function __construct(private UserRepo $r, private LoggerInterface $l, private Gone $g) { helper(); } }\n';

test('PSR-4: class uses resolve to the analyzed files; outside every prefix is external, a missing project class and a function are not', () => {
    // src/Support/helper.php exists: a `use function` must still not resolve to it (PSR-4 loads classes only).
    withProject({'composer.json': COMPOSER, 'src/Repo/UserRepo.php': REPO, 'src/Service/UserService.php': SERVICE, 'src/Support/helper.php': '<?php\nnamespace App\\Support;\nfunction helper() {}\n'}, (dir) => {
        const {graph, rules} = graphOf(dir);
        const repo = join(dir, 'src/Repo/UserRepo.php');
        const service = join(dir, 'src/Service/UserService.php');
        assert.deepEqual(
            graph.edges.map((edge) => [edge.from, edge.to, edge.specifier, edge.resolution]),
            [
                [repo, service, 'App\\Service\\UserService', 'psr4'],
                [service, repo, 'App\\Repo\\UserRepo', 'psr4']
            ]
        );
        assert.deepEqual(
            graph.unresolved.map((entry) => [entry.specifier, entry.external]),
            [
                ['App\\Missing\\Gone', false],
                ['App\\Support\\helper', false],
                ['Psr\\Log\\LoggerInterface', true]
            ]
        );
        // A `use` counts as a TS `import` does: the two classes form a cycle.
        assert.deepEqual([...(cycleAdjacency(graph).get(repo) ?? [])], [service]);
        assert.equal(rules.filter((rule) => rule === 'R-DEP-CYCLE').length, 1);
    });
});

test('PSR-4: without a composer.json nothing resolves and nothing is called external', () => {
    withProject({'src/Repo/UserRepo.php': REPO, 'src/Service/UserService.php': SERVICE}, (dir) => {
        const {graph} = graphOf(dir);
        assert.equal(graph.edges.length, 0);
        assert.ok(graph.unresolved.length > 0);
        assert.ok(graph.unresolved.every((entry) => entry.external === undefined), 'unknown — neither project nor package');
    });
});

test('PSR-4: a group use names its items under the group prefix', () => {
    const app = '<?php\nnamespace App;\nuse App\\Repo\\{UserRepo, function make};\nclass Kernel { public function x(UserRepo $r) { make(); } }\n';
    withProject({'composer.json': COMPOSER, 'src/Kernel.php': app, 'src/Repo/UserRepo.php': REPO.replace('use App\\Service\\UserService;\n', '').replace('UserService $s', '')}, (dir) => {
        const {graph} = graphOf(dir);
        const kernel = join(dir, 'src/Kernel.php');
        assert.deepEqual(
            graph.edges.filter((edge) => edge.from === kernel).map((edge) => [edge.specifier, edge.to]),
            [['App\\Repo\\UserRepo', join(dir, 'src/Repo/UserRepo.php')]]
        );
        assert.deepEqual(
            graph.unresolved.filter((entry) => entry.from === kernel).map((entry) => [entry.specifier, entry.external]),
            [['App\\Repo\\make', false]]
        );
    });
});

test('PSR-4 lookup order: longest prefix first, directories in declared order, autoload-dev merged; a leading backslash is ignored', () => {
    const composer = JSON.stringify({autoload: {'psr-4': {'App\\': ['src/', 'lib/'], 'App\\Legacy\\': 'legacy/'}}, 'autoload-dev': {'psr-4': {'App\\Tests\\': 'tests/'}}});
    withProject({'composer.json': composer}, (dir) => {
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        const analyzed = new Set([join(dir, 'src/Legacy/Old.php'), join(dir, 'legacy/Old.php'), join(dir, 'lib/Util.php'), join(dir, 'tests/UserTest.php')]);
        assert.deepEqual(resolver.resolvePhpClass('App\\Legacy\\Old', analyzed), {target: join(dir, 'legacy/Old.php'), external: false}, 'the longer prefix wins');
        assert.deepEqual(resolver.resolvePhpClass('\\App\\Util', analyzed), {target: join(dir, 'lib/Util.php'), external: false}, 'the second directory');
        assert.deepEqual(resolver.resolvePhpClass('App\\Tests\\UserTest', analyzed), {target: join(dir, 'tests/UserTest.php'), external: false}, 'autoload-dev');
        assert.deepEqual(resolver.resolvePhpClass('Vendor\\Thing', analyzed), {target: null, external: true});
        assert.deepEqual(resolver.resolvePhpClass('App', analyzed), {target: null, external: true}, 'a prefix itself names no class below it');
    });
});

test('PSR-4: a file Composer would load first but that was not analyzed makes the name unresolved, never a later candidate', () => {
    const composer = JSON.stringify({autoload: {'psr-4': {'App\\': ['src/', 'lib/']}}});
    withProject({'composer.json': composer, 'src/Util.php': '<?php // excluded from the analysis\n'}, (dir) => {
        const resolver = new ModuleResolver(loadProjectConfig(dir));
        assert.deepEqual(resolver.resolvePhpClass('App\\Util', new Set([join(dir, 'lib/Util.php')])), {target: null, external: false});
    });
});

test('PSR-4: the fallback prefix makes no name external; a malformed or absent composer.json leaves PHP names unknown', () => {
    withProject({'composer.json': JSON.stringify({autoload: {'psr-4': {'': 'src/'}}})}, (dir) => {
        assert.deepEqual(new ModuleResolver(loadProjectConfig(dir)).resolvePhpClass('Vendor\\Thing', new Set()), {target: null, external: false});
    });
    withProject({'composer.json': '{ not json'}, (dir) => {
        assert.equal(loadProjectConfig(dir).psr4, undefined);
        assert.deepEqual(new ModuleResolver(loadProjectConfig(dir)).resolvePhpClass('App\\X', new Set()), {target: null, external: undefined});
    });
    assert.deepEqual(new ModuleResolver(EMPTY_PROJECT_CONFIG).resolvePhpClass('App\\X', new Set()), {target: null, external: undefined});
});

// Identity spec, phase 4: PHP types in the TypeModel — `struct.typeDecl`
// facts resolved by PHP's name rules, so the SOLID rules see PHP hierarchies.

const SOLID_FILES: Record<string, string> = {
    'composer.json': COMPOSER,
    'src/Repo/Repository.php': '<?php\nnamespace App\\Repo;\ninterface Repository { public function find(int $id); public function save($row); public function delete($row); }\n',
    'src/Repo/BaseRepo.php': '<?php\nnamespace App\\Repo;\nclass BaseRepo { public function save($row) { return $row; } }\n',
    'src/Repo/ReadOnlyRepo.php':
        '<?php\nnamespace App\\Repo;\nuse App\\Support\\Logs;\nuse Psr\\Log\\LoggerAwareInterface;\n' +
        'final class ReadOnlyRepo extends BaseRepo implements Repository, LoggerAwareInterface {\n    use Logs;\n    public function find(int $id) { return null; }\n' +
        "    #[\\Override] public function save($row) { throw new \\BadMethodCallException('Not supported'); }\n    public function delete($row) {}\n}\n",
    'src/Support/Logs.php': '<?php\nnamespace App\\Support;\ntrait Logs { public function log(string $m) { echo $m; } }\n'
};

test('PHP TypeModel: supertypes resolve by namespace, use alias and PSR-4; trait members are inherited; LSP and ISP see PHP', () => {
    withProject(SOLID_FILES, (dir) => {
        const result = analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config: DEFAULT_CONFIG, solid: true});
        const decl = result.facts.find((fact) => fact.kind === 'struct.typeDecl' && fact.subject.symbol === 'App\\Repo\\ReadOnlyRepo');
        assert.ok(decl !== undefined, 'a struct.typeDecl under the type identity');
        const value = decl.value as {declKind: string; supertypes: unknown[]; members: {name: string; memberKind: string; body?: string; isOverride?: boolean}[]};
        assert.equal(value.declKind, 'class');
        assert.deepEqual(value.supertypes, [
            {prefix: null, name: 'BaseRepo', kind: 'extends'},
            {prefix: null, name: 'Repository', kind: 'implements'},
            {prefix: null, name: 'LoggerAwareInterface', kind: 'implements'},
            {prefix: null, name: 'Logs', kind: 'with'}
        ]);
        assert.deepEqual(
            value.members.map((member) => [member.name, member.body, member.isOverride ?? false]),
            [
                ['find', 'normal', false],
                ['save', 'throws-unsupported', true],
                ['delete', 'empty', false]
            ]
        );

        const graph = graphOf(dir).graph;
        const model = buildTypeModel(result.facts, new Set(result.facts.map((fact) => fact.subject.file)), undefined, graph);
        const node = model.get(`${join(dir, 'src/Repo/ReadOnlyRepo.php')}#App\\Repo\\ReadOnlyRepo`);
        assert.ok(node !== undefined);
        assert.deepEqual(
            node.supertypes.map((supertype) => [supertype.name, supertype.status, supertype.target ?? supertype.origin]),
            [
                ['BaseRepo', 'project', `${join(dir, 'src/Repo/BaseRepo.php')}#App\\Repo\\BaseRepo`],
                ['Repository', 'project', `${join(dir, 'src/Repo/Repository.php')}#App\\Repo\\Repository`],
                ['LoggerAwareInterface', 'external', 'Psr\\Log\\LoggerAwareInterface'],
                ['Logs', 'project', `${join(dir, 'src/Support/Logs.php')}#App\\Support\\Logs`]
            ]
        );
        assert.deepEqual(node.inherited.map(({member, from}) => [member.name, from.split('#')[1]]), [['log', 'App\\Support\\Logs']], 'the trait method; save is its own');
        assert.equal(node.hierarchyComplete, true, 'extends and with reach project types; implements is no inheritance (TypeModel contract)');

        const solid = result.report.findings.filter((finding) => finding.rule.id.startsWith('R-SOLID-')).map((finding) => [finding.rule.id, finding.location.symbol]);
        assert.deepEqual(solid, [
            ['R-SOLID-ISP-INTERFACE-COHESION', 'App\\Repo\\ReadOnlyRepo:App\\Repo\\Repository'],
            ['R-SOLID-LSP-CONTRACT-COMPATIBILITY', 'App\\Repo\\ReadOnlyRepo.save']
        ]);
    });
});

test('PHP TypeModel: a fully qualified, a namespace-relative and an unknown name; several namespaces in one file leave relative names unresolved', () => {
    const files = {
        'composer.json': COMPOSER,
        'src/A.php': '<?php\nnamespace App;\nclass A extends \\App\\B implements namespace\\I, \\Countable {}\n',
        'src/B.php': '<?php\nnamespace App;\nclass B {}\ninterface I {}\n',
        'src/Multi.php': '<?php\nnamespace App\\X { class M extends B {} }\nnamespace App\\Y { class N extends \\App\\B {} }\n'
    };
    withProject(files, (dir) => {
        const result = analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config: DEFAULT_CONFIG});
        const model = buildTypeModel(result.facts, new Set(result.facts.map((fact) => fact.subject.file)), undefined, graphOf(dir).graph);
        const statuses = (file: string, name: string): string[][] => (model.get(`${join(dir, file)}#${name}`)?.supertypes ?? []).map((supertype) => [supertype.name, supertype.status]);
        assert.deepEqual(statuses('src/A.php', 'App\\A'), [
            ['B', 'project'],
            ['I', 'project'],
            ['Countable', 'unresolved']
        ]);
        assert.deepEqual(statuses('src/Multi.php', 'App\\X\\M'), [['B', 'unresolved']], 'several namespaces in the file: the relative name is not guessed');
        assert.deepEqual(statuses('src/Multi.php', 'App\\Y\\N'), [['B', 'project']]);
    });
});

test('an interface or abstract method (body null) is not measured and no longer fails the whole analysis', () => {
    withProject({'i.php': '<?php\ninterface I { public function f(); }\nabstract class A { abstract public function g(); public function h() { return 1; } }\n'}, (dir) => {
        const result = analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config: DEFAULT_CONFIG});
        assert.equal(result.report.coverage.status, 'complete');
        assert.deepEqual(result.facts.filter((fact) => fact.kind === 'metric.functionLength').map((fact) => fact.subject.symbol), ['A.h']);
    });
});

test('PHP struct.typeDecl: references of a body, promoted constructor parameters, constants and static members', () => {
    const source =
        '<?php\nnamespace App;\nuse App\\R\\Repo as R;\nclass A {\n    public const X = 1;\n    private static ?Foo $p = null;\n' +
        '    public function __construct(private readonly R $repo, int $k) {}\n' +
        '    public function m() { $x = new R(); $y = R::$inst; $z = R::C; R::make(); $c = R::class; $this->repo; $this?->m(); return self::X + static::$p; }\n}\n';
    withProject({'a.php': source}, (dir) => {
        const result = analyze({rootPath: dir, knowledgeDir: join(testDir, '..', 'knowledge', 'marcus'), ruleSetDir: join(testDir, '..', 'rules', 'default'), config: DEFAULT_CONFIG});
        const value = result.facts.find((fact) => fact.kind === 'struct.typeDecl')?.value as {members: Record<string, unknown>[]};
        const strip = ({range: _range, ...rest}: Record<string, unknown>): Record<string, unknown> => rest;
        assert.deepEqual(value.members.map(strip), [
            {name: 'X', memberKind: 'field', isStatic: true},
            {name: 'p', memberKind: 'field', isStatic: true, declaredType: {prefix: null, name: 'Foo'}},
            {
                name: '__construct',
                memberKind: 'constructor',
                params: [
                    {name: 'repo', type: {prefix: null, name: 'R'}, isFieldFormal: true},
                    {name: 'k', type: null, isFieldFormal: false}
                ]
            },
            {name: 'repo', memberKind: 'field', declaredType: {prefix: null, name: 'R'}},
            {
                name: 'm',
                memberKind: 'method',
                body: 'normal',
                refsMembers: ['X', 'm', 'p', 'repo'],
                refsImports: ['R'],
                instantiates: [{prefix: null, name: 'R', member: null}],
                staticAccess: [
                    {prefix: null, name: 'R', member: '$inst'},
                    {prefix: null, name: 'R', member: 'C'}
                ]
            }
        ]);
    });
});
