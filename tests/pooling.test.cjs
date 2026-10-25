const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const html = fs.readFileSync('web/index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
const ctx = vm.createContext({ console, window: {}, setTimeout, clearTimeout, performance });
vm.runInContext(scripts[0] + '\nglobalThis.api = { NN, NNVar };', ctx);
const { NN, NNVar } = ctx.api;
const options = { noMain: true, shapeComments: false, literalDims: true };
function source(ctor, expression = 'self.pool(x)') {
  return `import torch\nimport torch.nn as nn\nimport torch.nn.functional as F\n\nclass PoolNet(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.pool = ${ctor}\n\n    def forward(self, x):\n        return ${expression}\n`;
}
function graph(ctor, shape) {
  const result = NN.importPython(source(ctor));
  assert.equal(result.warnings.length, 0, result.warnings.join('; '));
  const g = result.graph;
  g.nodes.find(n => n.type === 'input').params.shape = shape.join(', ');
  return g;
}
const cases = [
  ['nn.AvgPool1d(3, stride=2, padding=1, ceil_mode=True, count_include_pad=False)', [2, 3, 8]],
  ['nn.AvgPool2d((3, 2), stride=(2, 1), padding=(1, 1), divisor_override=5)', [2, 3, 8, 9]],
  ['nn.MaxPool1d(2, stride=2, padding=1, ceil_mode=True)', [3, 7]],
  ['nn.MaxPool2d((3, 2), stride=(2, 1), padding=(1, 1), dilation=(2, 1), ceil_mode=True)', [2, 3, 32, 32]],
  ['nn.AdaptiveAvgPool1d(3)', [2, 3, 8]],
  ['nn.AdaptiveAvgPool2d((None, 3))', [2, 3, 8, 9]],
  ['nn.AdaptiveAvgPool2d((None, None))', [3, 8, 9]],
  ['nn.AvgPool2d(2, stride=None)', [2, 3, 8, 8]],
];

test('native pooling constructors survive Python round trips', () => {
  for (const [ctor, shape] of cases) {
    const g = graph(ctor, shape);
    assert.equal(g.nodes.filter(n => n.type === 'pool').length, 1);
    const code = NN.generate(g, options).code;
    const round = NN.importPython(code);
    assert.equal(NN.generate(round.graph, options).code, code);
    assert.doesNotMatch(code, /def __init__\(self, None/);
    assert.equal(NN.inferShapes(g).errors.size, 0, ctor);
  }
});

test('pooling validates ranks and spatial parameters', () => {
  for (const [ctor, shape, error] of [
    ['nn.AvgPool2d(2)', [2, 8], /3D or 4D/],
    ['nn.MaxPool1d(0)', [2, 3, 8], /Kernel size/],
    ['nn.AvgPool2d(2, stride=0)', [2, 3, 8, 8], /Stride/],
    ['nn.MaxPool2d(2, padding=2)', [2, 3, 8, 8], /padding/],
    ['nn.AvgPool2d(2, divisor_override=0)', [2, 3, 8, 8], /divisor_override/],
    ['nn.MaxPool1d(16)', [2, 3, 8], /empty output/],
  ]) {
    const g = graph(ctor, shape);
    const pool = g.nodes.find(n => n.type === 'pool');
    assert.match(NN.inferShapes(g).errors.get(pool.id), error);
  }
});

test('functional max pooling preserves positional ceil_mode and return_indices ordering', () => {
  const g = NN.importPython(source('nn.Identity()', 'F.max_pool2d(x, 3, 2, 1, 1, True, False)')).graph;
  const pool = g.nodes.find(n => n.type === 'pool');
  assert.ok(pool);
  assert.equal(pool.params.ceil_mode, true);
  assert.match(NN.generate(g, options).code, /ceil_mode=True/);
});

test('all functional pooling kinds import and symbolic kernel sizes stay configurable', () => {
  for (const [kind, spec] of Object.entries(NN.POOLS)) {
    const g = NN.importPython(source('nn.Identity()', `F.${spec.fn}(x, 2)`)).graph;
    assert.equal(g.nodes.find(n => n.type === 'pool').params.kind, kind);
  }
  const src = source('nn.AvgPool2d(kernel)').replace('def __init__(self):', 'def __init__(self, kernel=2):');
  const g = NN.importPython(src).graph;
  assert.equal(g.nodes.find(n => n.type === 'pool').params.kernel_size, 'kernel');
  assert.match(NN.generate(g, { ...options, literalDims: false }).code, /kernel_size=kernel/);
  assert.throws(() => NN.importPython(source('nn.MaxPool2d(2, return_indices=True)')), /return_indices=True is not supported/);
});

test('FX pooling module and functional metadata produce pooling nodes', () => {
  for (const operation of [
    { op: 'call_module', target: 'pool', module: { type: 'AdaptiveAvgPool2d', output_size: [null, 4] }, args: [{ node: 'x' }] },
    { op: 'call_function', target: 'torch.nn.functional.max_pool2d', args: [{ node: 'x' }, 3, 2, 1, 1, true, false] },
    { op: 'call_function', target: 'torch._C._nn.avg_pool2d', args: [{ node: 'x' }, '(3, 2)'], kwargs: { stride: null } },
    { op: 'call_function', target: 'torch.adaptive_avg_pool1d', args: [{ node: 'x' }, 4] },
  ]) {
    const result = NN.importFx({ name: 'PoolNet', nodes: [
      { op: 'placeholder', name: 'x', shape: [2, 3, 8, 8] },
      { ...operation, name: 'p' },
      { op: 'output', name: 'out', args: [{ node: 'p' }] },
    ] });
    assert.equal(result.warnings.length, 0);
    assert.equal(result.graph.nodes.filter(n => n.type === 'pool').length, 1);
    assert.match(NN.generate(result.graph, options).code, /nn\.(AdaptiveAvgPool[12]d|MaxPool2d|AvgPool2d)/);
  }
});

test('pooling source sync preserves notebook code and edits only the constructor', () => {
  const src = 'import marimo\napp = marimo.App()\nwith app.setup:\n    import torch.nn as nn\n\n@app.class_definition\n' + source('nn.AvgPool2d(2)').split('class PoolNet')[1].replace(/^/, 'class PoolNet') + '\n# training code stays\n';
  const g = NN.importPython(src).graph;
  assert.equal(NN.syncSource(src, g), src);
  g.nodes.find(n => n.type === 'pool').params.kernel_size = '4';
  const out = NN.syncSource(src, g);
  assert.match(out, /@app.class_definition\nclass PoolNet/);
  assert.match(out, /kernel_size=4/);
  assert.ok(out.endsWith('# training code stays\n'));
  assert.equal(out.split('    def forward')[1], src.split('    def forward')[1]);
});

test('pooling variance reports unsupported instead of predicting an identity', () => {
  const result = NNVar.predict(graph('nn.AvgPool2d(2)', ['e', 3, 8, 8]), {});
  assert.match(result.error, /pooling/);
});

test('generated pooling outputs, input gradients, and inferred shapes match PyTorch', {
  skip: !process.env.TORCH_CANVAS_TEST_PYTHON && 'Set TORCH_CANVAS_TEST_PYTHON to a Python interpreter with torch installed',
}, () => {
  const records = cases.map(([ctor, shape]) => {
    const g = graph(ctor, shape);
    const pool = g.nodes.find(n => n.type === 'pool');
    return { ctor, shape, code: NN.generate(g, options).code,
      inferred: Array.from(NN.inferShapes(g).shapes.get(pool.id), Number) };
  });
  const result = spawnSync(process.env.TORCH_CANVAS_TEST_PYTHON, ['-c', `
import json, sys, torch
from torch import nn
torch.manual_seed(17)
for case in json.load(sys.stdin):
    scope = {}
    exec(case['code'], scope)
    model = scope['PoolNet']()
    reference = eval(case['ctor'])
    x = torch.randn(case['shape'], requires_grad=True)
    y = model(x)
    expected = reference(x)
    assert list(y.shape) == case['inferred'], (case, y.shape)
    torch.testing.assert_close(y, expected)
    grad = torch.randn_like(y)
    actual_grad = torch.autograd.grad(y, x, grad)[0]
    expected_grad = torch.autograd.grad(expected, x, grad)[0]
    torch.testing.assert_close(actual_grad, expected_grad)
print('All pooling output and gradient checks passed')
`], { input: JSON.stringify(records), encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
