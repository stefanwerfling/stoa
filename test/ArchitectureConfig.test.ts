import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ArchitectureModel, loadArchitectureConfig, packageNameOf, type ArchitectureConfig} from '../src/architecture/ArchitectureConfig.js';
import {initDart} from '../src/analysis/DartAdapter.js';
import {DEFAULT_CONFIG} from '../src/Config.js';
import {analyze} from '../src/Pipeline.js';
import {toMarkdown} from '../src/reporting/Reporter.js';

// Flutter quality track E5b: architecture config R6 (`--architecture`).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = join(here, 'fixtures', 'architecture');
const project = join(fixture, 'project');
const configPath = join(fixture, 'configs', 'stoa.architecture.json');
const knowledgeDir = join(root, 'knowledge', 'marcus');
const ruleSetDir = join(root, 'rules', 'default');

let config: ArchitectureConfig;
let model: ArchitectureModel;
const at = (path: string): string => join(project, path);

before(async () => {
    await initDart();
    config = loadArchitectureConfig(configPath);
    model = new ArchitectureModel(config, project);
});

test('E5b loader: a valid config loads; undeclared layers in allow/forbidPackages are a warning, not an error', () => {
    assert.deepEqual(config.layers.map((layer) => layer.name), ['ui', 'data', 'tools']);
    assert.deepEqual(config.unknownLayerReferences, ['domain']);
});

test('E5b loader: invalid JSON, schema violations and duplicate layer names fail with a clear message', () => {
    assert.throws(() => loadArchitectureConfig(join(fixture, 'configs', 'not-json.json')), /is not valid JSON/);
    assert.throws(() => loadArchitectureConfig(join(fixture, 'configs', 'schema-error.json')), /does not match architecture\.schema\.json: .*\/layers\/0\/name.*\/layers\/0\/include/);
    assert.throws(() => loadArchitectureConfig(join(fixture, 'configs', 'duplicate.json')), /declares layer\(s\) more than once: ui/);
});

test('E5b assignment: first matching layer wins, several matches are recorded, a file outside every layer (or the root) is unknown', () => {
    assert.deepEqual(model.assignment(at('lib/Pages/home.dart')), {layer: 'ui', matches: ['ui']});
    assert.deepEqual(model.assignment(at('lib/Service/api.dart')), {layer: 'data', matches: ['data']});
    assert.deepEqual(model.assignment(at('lib/Pages/Service/odd.dart')), {layer: 'ui', matches: ['ui', 'data']});
    assert.deepEqual(model.assignment(at('lib/main.dart')), {layer: null, matches: []});
    assert.deepEqual(model.assignment(join(fixture, 'configs', 'lib', 'Pages', 'x.dart')), {layer: null, matches: []}, 'outside the root');
});

test('E5b edges: within a layer always allowed, between layers only via allow, an end without a layer is unknown', () => {
    assert.equal(model.edgeVerdict(at('lib/Pages/home.dart'), at('lib/Widgets/tile.dart')), 'same-layer');
    assert.equal(model.edgeVerdict(at('lib/Pages/home.dart'), at('lib/Service/api.dart')), 'forbidden');
    assert.equal(model.edgeVerdict(at('lib/Service/api.dart'), at('lib/Pages/home.dart')), 'forbidden');
    assert.equal(model.edgeVerdict(at('lib/Pages/home.dart'), at('tool/gen.dart')), 'allowed');
    assert.equal(model.edgeVerdict(at('lib/Pages/home.dart'), at('lib/main.dart')), 'unknown');
    assert.equal(model.edgeVerdict(at('lib/main.dart'), at('lib/Db/db.dart')), 'unknown');
});

test('E5b package bans: per layer, by package name; a file without a layer bans nothing; packageNameOf normalizes specifiers', () => {
    assert.equal(model.isPackageForbidden(at('lib/Pages/home.dart'), 'http'), true);
    assert.equal(model.isPackageForbidden(at('lib/Pages/home.dart'), 'provider'), false);
    assert.equal(model.isPackageForbidden(at('lib/Service/api.dart'), 'http'), false);
    assert.equal(model.isPackageForbidden(at('lib/main.dart'), 'http'), false);
    assert.equal(packageNameOf('package:http/http.dart'), 'http');
    assert.equal(packageNameOf('package:arch_app/Service/api.dart', new Set(['arch_app'])), null, 'own package');
    assert.equal(packageNameOf('dart:io'), 'dart:io');
    assert.equal(packageNameOf('axios/lib/core'), 'axios');
    assert.equal(packageNameOf('@scope/net/client'), '@scope/net');
    assert.equal(packageNameOf('../Service/api.dart'), null);
    assert.equal(packageNameOf('/abs/x.ts'), null);
});

test('E5b report: the pipeline adds the architecture summary only with a config; markdown shows sizes and warnings', () => {
    const withConfig = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG, architecture: config});
    assert.deepEqual(withConfig.report.architecture, {
        path: configPath,
        version: '1.0.0',
        layers: [
            {name: 'ui', files: 3},
            {name: 'data', files: 2},
            {name: 'tools', files: 0}
        ],
        unassignedFiles: 1,
        warnings: {
            multipleMatchCount: 1,
            multipleMatchSample: [{file: 'lib/Pages/Service/odd.dart', layers: ['ui', 'data']}],
            emptyLayers: ['tools'],
            unknownLayerReferences: ['domain']
        }
    });
    const markdown = toMarkdown(withConfig.report);
    assert.match(markdown, /- Architecture: ui 3, data 2, tools 0; 1 files without a layer/);
    assert.match(markdown, /1 files matching several layers \(first wins\): lib\/Pages\/Service\/odd\.dart \(ui, data\)/);
    const without = analyze({rootPath: project, knowledgeDir, ruleSetDir, config: DEFAULT_CONFIG});
    assert.equal('architecture' in without.report, false);
    assert.deepEqual(withConfig.report.findings, without.report.findings, 'no rule reads the config before E6d');
});

test('E5b CLI: --architecture with a broken file fails fast with the loader message and the config-error exit code (as --contracts)', () => {
    const result = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', project, '--architecture', join(fixture, 'configs', 'duplicate.json')], {cwd: root, encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /declares layer\(s\) more than once: ui/);
    const ok = spawnSync('node', ['--import', 'tsx', 'src/Cli.ts', 'analyze', project, '--architecture', configPath, '--format', 'json'], {cwd: root, encoding: 'utf8'});
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal((JSON.parse(ok.stdout) as {architecture: {unassignedFiles: number}}).architecture.unassignedFiles, 1);
});
