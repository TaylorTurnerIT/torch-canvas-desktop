const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const html = fs.readFileSync('web/index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance });
vm.runInContext(scripts.slice(0, 3).join('\n') + '\nglobalThis.api = { NN, NNVar, NNExport, library: window.TC_LIBRARY };', Object.assign(ctx, { window: {} }));
const { NN, NNVar, NNExport, library } = ctx.api;

test('symbolic sizes and variance work when dynamic code compilation is blocked', () => {
  const restricted = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(scripts[0] + '\nglobalThis.api = { NN, NNVar };', restricted);
  assert.equal(restricted.api.NN.evalDim('d / heads', { d: 256, heads: 8 }), 32);
  const result = restricted.api.NNVar.predict(restricted.api.NN.presetResidualMLP(), {});
  assert.equal(result.error, undefined);
  assert.ok(result.layers.length > 0);
});

test('dimension arithmetic preserves precedence and rejects invalid sizes', () => {
  for (const [expression, value] of [
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['17 // 3', 5],
    ['2 ** 3 ** 2', 512], ['2 ** -2', 0], ['(-2) ** 2', 4],
    ['-17 / 3', -6], ['.5 * 8', 4], ['3 - -2', 5],
    ['1 / 0', null], ['missing + 1', null], ['2 +', null],
    ['2(3)', null], ['(2 + 3', null], ['globalThis.process.exit()', null],
    ['-2 ** 2', null], ['++2', null], ['2--2', null], ['1.5', 1.5],
  ]) assert.equal(NN.evalDim(expression, {}), value, expression);
  assert.equal(NN.evalDim('large / 2', { large: 1e22 }), 5e21);
});

test('unresolved or nonpositive prediction sizes return a useful error', () => {
  for (const value of [undefined, 0, -1]) {
    const graph = NN.presetResidualMLP();
    graph.symbols.o = value;
    const result = NNVar.predict(graph, {});
    assert.match(result.error, /positive numeric sizes/);
    assert.ok(result.node);
  }
});

test('upstream provenance names the repository, author, and license', () => {
  const meta = JSON.parse(fs.readFileSync('upstream/source.json'));
  assert.equal(meta.repo, 'https://github.com/JesseTNRoberts/torch-canvas');
  assert.equal(meta.author, 'Jesse Roberts');
  assert.match(meta.license, /^MIT/);
});

test('default graph generates parseable Python and imports back', () => {
  const graph = NN.presetResidualMLP();
  const generated = NN.generate(graph, {}).code;
  assert.match(generated, /class ResidualMLP/);
  assert.match(generated, /def forward/);
  const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: generated, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const imported = NN.importPython(generated);
  assert.ok(imported.graph.nodes.length > 0);
  assert.match(NN.generate(imported.graph, {}).code, /def forward/);
});

test('all bundled graph examples generate syntactically valid Python', () => {
  assert.ok(library.length > 10);
  for (const entry of library.filter(x => x.type === 'json')) {
    const graph = JSON.parse(entry.source).graph;
    // Standalone library graphs store nested blocks by library path, not inline.
    // Resolve them as the editor does instead of silently exporting missing blocks.
    const blocks = graph.blocks || (graph.blocks = {});
    const link = scope => {
      for (const node of scope.nodes.filter(n => n.type === 'block')) {
        if (!blocks[node.params.block]) {
          const entry = library.find(e => e.file === node.params.lib);
          assert.ok(entry, `Missing library block ${node.params.lib}`);
          const inner = entry.type === 'json' ? JSON.parse(entry.source).graph : NN.importPython(entry.source).graph;
          blocks[node.params.block] = { id: node.params.block, name: inner.name, graph: inner };
          link(inner);
        }
      }
    };
    link(graph);
    const generated = NN.generate(graph, {}).code;
    const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: generated, encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${entry.file}: ${parsed.stderr}`);
  }
});

test('variance engine predicts the default graph', () => {
  const result = NNVar.predict(NN.presetResidualMLP(), {});
  assert.ok(result);
  assert.equal(result.error, undefined);
});

test('training exporter produces valid Python', () => {
  const graph = JSON.parse(fs.readFileSync('tests/training-graph.json'));
  const result = NNExport.trainScript(graph, NNExport.defaults(graph));
  assert.equal(result.errors.length, 0, result.errors.join('; '));
  assert.match(result.train, /optimizer/);
  const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: result.train, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('saving into a marimo notebook keeps its decorators and setup imports', () => {
  const nb = [
    'import marimo', '__generated_with = "0.25.1"', 'app = marimo.App()', '',
    'with app.setup:', '    import marimo as mo', '    import torch.nn as nn', '', '',
    '@app.class_definition', 'class Net(nn.Module):', '    def __init__(self):', '        super().__init__()',
    '        self.fc = nn.Linear(4, 2)', '', '    def forward(self, x):', '        return self.fc(x)', '', '',
    '@app.cell', 'def _():', '    mo.md("hi")', '    return', '', '',
    'if __name__ == "__main__":', '    app.run()', '',
  ].join('\n');
  assert.ok(NN.isMarimo(nb));
  const res = NN.importPython(nb, {});
  const g = res.graph;
  const gen = NN.generate(g, { className: g.name }).code;
  const out = NN.mergeIntoSource(nb, gen, res.usedClasses);
  assert.match(out, /^@app\.class_definition\nclass Net\(nn\.Module\):/m);
  assert.doesNotMatch(out, /^import torch/m);
  assert.match(out, /^@app\.cell\ndef _\(\):\n    mo\.md\("hi"\)/m);
  // Missing imports go into the setup cell, never to column 0.
  const noTorch = nb.replace('    import torch.nn as nn\n', '    import torch.nn as nn\n    import torch\n');
  const out2 = NN.mergeIntoSource(noTorch.replace(/^    import torch\n/m, ''), gen, res.usedClasses);
  assert.doesNotMatch(out2, /^import torch/m);
  assert.equal(spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: out }).status, 0);
});

test('plain Python files still merge without marimo handling', () => {
  const src = 'import torch.nn as nn\n\n\nclass Net(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.fc = nn.Linear(4, 2)\n\n    def forward(self, x):\n        return self.fc(x)\n';
  assert.ok(!NN.isMarimo(src));
  const res = NN.importPython(src, {});
  const out = NN.mergeIntoSource(src, NN.generate(res.graph, { className: res.graph.name }).code, res.usedClasses);
  assert.doesNotMatch(out, /@app/);
});

test('syncSource applies diagram edits to hand-written code without regenerating it', () => {
  const src = fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8');
  const parse = text => NN.importPython(text, {}).graph;
  assert.equal(NN.syncSource(src, parse(src), {}), src);
  // A size edit rewrites one statement and leaves comments, docstrings, and other methods.
  const sized = parse(src);
  sized.nodes.find(n => n.params.name === 'fc1').params.out = '32';
  const out = NN.syncSource(src, sized, {});
  assert.equal(out, src.replace('nn.Linear(n_in, 16)', 'nn.Linear(n_in, 32)'));
  // An added layer inserts its constructor statement and rewrites forward, keeping the docstring.
  const edited = src
    .replace('        self.act = nn.ReLU()\n', '        self.act = nn.ReLU()\n        self.drop = nn.Dropout(0.1)\n')
    .replace('self.fc2(self.act(self.fc1(x)))', 'self.fc2(self.drop(self.act(self.fc1(x))))');
  const grown = NN.syncSource(src, parse(edited), {});
  for (const kept of ['# keep me', '"""Doc."""', 'def predict', '@app.class_definition', 'n_in, 16)']) assert.ok(grown.includes(kept), kept);
  assert.match(grown, /self\.drop = nn\.Dropout\(0\.1\)/);
  assert.equal(NN.syncSource(grown, parse(edited), {}), grown);
  assert.equal(spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: grown }).status, 0);
  // Renaming the model renames its class.
  const renamed = parse(src); renamed.name = 'Renamed';
  assert.match(NN.syncSource(src, renamed, {}), /^class Renamed\(nn\.Module\):/m);
});

test('a size set through a symbol reaches a literal file', () => {
  const base = NN.generate(NN.presetResidualMLP(), { literalDims: true }).code;
  const g = NN.importPython(base).graph;
  g.symbols.d256 = 64;
  NN.syncWidths(g);
  const out = NN.syncSource(base, g, { gen: { literalDims: true, shapeComments: true } });
  assert.notEqual(out, base);
  assert.match(out, /nn\.Linear\(784, 64, bias=False\)/);
});

const branchedGate = fs.readFileSync('tests/fixtures/branched-gate.py', 'utf8');

test('a connected LayerNorm fork into two linear branches generates a tensor gate', () => {
  const graph = NN.importPython(branchedGate).graph;
  const generated = NN.generate(graph, { shapeComments: false }).code;
  assert.doesNotMatch(generated, /return None/);
  assert.match(generated, /nn\.LayerNorm/);
  assert.match(generated, /\*/);
  assert.equal(NN.syncSource(branchedGate, graph), branchedGate);
  assert.doesNotThrow(() => NN.importPython(generated));
});

test('disconnected model or nested block outputs cannot overwrite working source', () => {
  for (const nested of [false, true]) {
    const graph = NN.importPython(branchedGate).graph;
    const scope = nested ? Object.values(graph.blocks)[0].graph : graph;
    const output = scope.nodes.find(n => n.type === 'output');
    scope.edges = scope.edges.filter(e => e.to !== output.id);
    assert.throws(() => NN.generate(graph), /connect input 1 of .*before saving Python/);
    assert.throws(() => NN.syncSource(branchedGate, graph), /connect input 1 of .*before saving Python/);
  }
});

test('a connected output still rejects a missing multiplication input', () => {
  const graph = NN.importPython(branchedGate).graph;
  const block = Object.values(graph.blocks)[0].graph;
  const multiply = block.nodes.find(n => n.type === 'binop' && n.params.op === '*');
  block.edges = block.edges.filter(e => !(e.to === multiply.id && e.port === 1));
  assert.throws(() => NN.generate(graph), /connect input 2 of .*before saving Python/);
  assert.throws(() => NN.syncSource(branchedGate, graph), /connect input 2 of .*before saving Python/);
});

test('completed gate repairs an older return-None block without losing other methods', () => {
  const graph = NN.importPython(branchedGate).graph;
  const broken = branchedGate
    .replace('        self.norm = nn.LayerNorm(width)\n', '')
    .replace('        self.left = nn.Linear(width, width)\n', '')
    .replace('        n = self.norm(x)\n        return self.left(n) * self.right(n)', '        return None');
  assert.throws(() => NN.importPython(broken), /expected a tensor input/);
  const repaired = NN.syncSource(broken, graph, { gen: { literalDims: false, shapeComments: false } });
  assert.doesNotMatch(repaired, /return None/);
  assert.match(repaired, /self\.norm = nn\.LayerNorm\(width\)/);
  assert.match(repaired, /self\.left = nn\.Linear\(width, width\)/);
  for (const kept of ["return 'keep this method'", 'def predict(self, x):', 'TRAINING_SETTING = 123'])
    assert.ok(repaired.includes(kept), kept);
  assert.doesNotThrow(() => NN.importPython(repaired));
  assert.equal(NN.syncSource(repaired, graph, { gen: { literalDims: false, shapeComments: false } }), repaired);
});

test('source recovery does not replace unrelated import failures', () => {
  const graph = NN.importPython(branchedGate).graph;
  const invalid = branchedGate.replace('return self.head_norm(self.gate(x))', 'return self.head_norm(None)');
  assert.throws(() => NN.syncSource(invalid, graph), /expected a tensor input/);
});
