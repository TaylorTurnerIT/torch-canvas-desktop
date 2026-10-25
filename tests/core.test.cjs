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

// Constructor compatibility and shape-changing edits must survive source sync.
const poolingSource = `import torch.nn as nn

class PoolNet(nn.Module):
    def __init__(self, in_features, num_classes, width=16, depth=6):
        super().__init__()
        self.fc = nn.Linear(in_features, width)
        self.head = nn.Linear(width, num_classes)

    def forward(self, x):
        return self.head(self.fc(x.flatten(start_dim=1)))
`;

function insertPool(NN, graph, beforeFlatten = false) {
  const flatten = graph.nodes.find(n => n.params.fn === '.flatten');
  const edge = graph.edges.find(e => beforeFlatten ? e.to === flatten.id : e.from === flatten.id);
  const pool = NN.makeNode('func', { init: 'nn.MaxPool1d(kernel_size=2, stride=None, padding=0, dilation=1, ceil_mode=False)', fn: '', n: 1, name: 'pool' });
  graph.nodes.push(pool);
  graph.edges.push({ id: NN.uid('e'), from: edge.from, to: pool.id, port: 0 });
  edge.from = pool.id;
  return pool;
}

test('flatten shape inference accepts positional, keyword, and default dimensions', () => {
  for (const [args, expected] of [
    ['start_dim=1', ['e', '3*32*32']], ['1', ['e', '3*32*32']],
    ['start_dim=1, end_dim=2', ['e', '3*32', '32']],
    ['end_dim=-2, start_dim=-3', ['e', '3*32', '32']],
    ['', ['e*3*32*32']],
  ]) {
    const graph = NN.importPython(poolingSource).graph;
    graph.nodes.find(n => n.type === 'input').params.shape = 'e, 3, 32, 32';
    const flatten = graph.nodes.find(n => n.params.fn === '.flatten');
    flatten.params.extra = args;
    assert.deepEqual(Array.from(NN.inferShapes(graph).shapes.get(flatten.id)), expected, args);
  }
});

test('pooling after flatten updates widths while preserving the source constructor API', () => {
  const graph = NN.importPython(poolingSource).graph;
  insertPool(NN, graph);
  NN.syncWidths(graph);
  const output = NN.syncSource(poolingSource, graph);
  assert.match(output, /def __init__\(self, in_features, num_classes, width=16, depth=6\):/);
  assert.match(output, /self\.pool = nn\.MaxPool1d/);
  const python = spawnSync(process.env.TORCH_CANVAS_TEST_PYTHON || 'python3', ['-c', `
import ast, sys
source = sys.stdin.read()
ast.parse(source)
try:
    import torch
except ImportError:
    sys.exit(77)
namespace = {}
exec(source, namespace)
for channels, size, classes in [(1, 28, 10), (3, 32, 10), (3, 32, 1000)]:
    model = namespace['PoolNet'](in_features=channels * size * size, num_classes=classes)
    logits = model(torch.randn(2, channels, size, size))
    assert logits.shape == (2, classes), logits.shape
    logits.square().mean().backward()
`], { input: output, encoding: 'utf8' });
  assert.ok(python.status === 0 || python.status === 77, python.stderr + '\n' + output);
  const reparsed = NN.importPython(output).graph;
  assert.equal(reparsed.nodes.find(n => n.type === 'input').params.shape, 'e, in_features');
  assert.equal(reparsed.nodes.find(n => n.params.name === 'fc').params.in, 'in_features//2');
  reparsed.nodes.find(n => n.params.name === 'pool').params.init = 'nn.MaxPool1d(4)';
  NN.syncWidths(reparsed);
  assert.match(NN.syncSource(output, reparsed), /nn\.Linear\(in_features\/\/4, width\)/);
  reparsed.nodes.find(n => n.params.name === 'pool').params.init = graph.nodes.find(n => n.params.name === 'pool').params.init;
  NN.syncWidths(reparsed);
  assert.equal(NN.syncSource(output, reparsed), output);
});

test('invalid pooling rank reports an error without rewriting downstream dimensions or dropping arguments', () => {
  const graph = NN.importPython(poolingSource).graph;
  graph.nodes.find(n => n.type === 'input').params.shape = 'e, 3, 32, 32';
  const pool = insertPool(NN, graph, true);
  const result = NN.inferShapes(graph);
  assert.match(result.errors.get(pool.id), /MaxPool1d.*2D or 3D/);
  assert.equal(result.shapes.get(pool.id), null);
  NN.syncWidths(graph);
  assert.equal(graph.nodes.find(n => n.params.name === 'fc').params.in, 'in_features');
  assert.match(NN.syncSource(poolingSource, graph), /def __init__\(self, in_features, num_classes, width=16, depth=6\):/);
});

test('custom module names and keyword names never become size arguments', () => {
  const graph = NN.importPython(poolingSource).graph;
  insertPool(NN, graph);
  const code = NN.generate(graph, { literalDims: false }).code;
  assert.match(code, /def __init__\(self, in_features=64, num_classes=64, width=16\):/);
  assert.doesNotMatch(code, /def __init__\([^\n]*(?:\bnn\b|MaxPool1d|kernel_size|None|False)/);
  assert.equal(spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code }).status, 0);
});

test('removing a symbolic consumer preserves existing constructor callers', () => {
  const graph = NN.importPython(poolingSource).graph;
  graph.nodes.find(n => n.params.name === 'fc').params.in = '32';
  graph.nodes.find(n => n.type === 'input').params.shape = 'e, 32';
  const output = NN.syncSource(poolingSource, graph);
  assert.match(output, /def __init__\(self, in_features, num_classes, width=16, depth=6\):/);
});

test('MaxPool1d dimensions match PyTorch for stride, padding, dilation, tuples, and ceil mode', () => {
  const cases = [
    ['e, 11', 'nn.MaxPool1d(2)', 5],
    ['e, 3, 11', 'nn.MaxPool1d(3, 2, 1)', 6],
    ['e, 3, 13', 'torch.nn.MaxPool1d(kernel_size=(3,), stride=(2,), padding=(1,), dilation=(2,))', 6],
    ['e, 11', 'nn.MaxPool1d(2, ceil_mode=True)', 6],
    ['e, 3, 10', 'nn.MaxPool1d(3, 3, 1, ceil_mode=True)', 4],
    ['e, 3, 1', 'nn.MaxPool1d(2, 2, 1, ceil_mode=True)', 1],
  ];
  for (const [shape, init, expected] of cases) {
    const input = NN.makeNode('input', { shape });
    const pool = NN.makeNode('func', { init, fn: '', n: 1 });
    const graph = { symbols: { e: 2 }, nodes: [input, pool], edges: [{ id: 'edge', from: input.id, to: pool.id, port: 0 }] };
    const result = NN.inferShapes(graph);
    assert.equal(result.errors.size, 0, init);
    const output = Array.from(result.shapes.get(pool.id));
    assert.equal(NN.evalDim(output.at(-1), graph.symbols), expected, init);
    assert.deepEqual(output.slice(0, -1), shape.split(', ').slice(0, -1));
  }
});
