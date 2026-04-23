import test from 'node:test';
import assert from 'node:assert/strict';

import { lintLuaScript } from '../../src/lua-lint.js';

test('lintLuaScript errors on Lua syntax failures', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local value =',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'lua_syntax_error'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L335-L358
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L335-L358
test('lintLuaScript errors when required Lua entry functions are missing', () => {
  const diagnostics = lintLuaScript([
    'function advance(ctx)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'missing_entry_function'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L335-L343
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L394-L400
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L335-L343
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L394-L400
test('lintLuaScript errors when Lua entry function signatures are invalid', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx, outputRequest)',
    'end',
    '',
    'function advance(state)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_entry_function_arity'
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_entry_function_parameter'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L107-L135
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L118-L135
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L335-L343
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L107-L135
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L118-L135
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L335-L343
test('lintLuaScript errors when outputSizeMode and onReset signature do not match', () => {
  const activeDiagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'active',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(activeDiagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_entry_function_arity'
  ));

  const passiveDiagnostics = lintLuaScript([
    'function onReset(ctx, outputRequest)',
    'end',
    '',
    'function advance(ctx)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(passiveDiagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_entry_function_arity'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L353-L358
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L376-L392
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L353-L358
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L376-L392
test('lintLuaScript errors on unknown ctx methods', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:explodeUniverse()',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unknown_ctx_method'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L394-L400
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L394-L400
test('lintLuaScript warns when reset-scope creation APIs are used outside onReset', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:createTarget("temp", 640, 480)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'reset_scope_creation_outside_on_reset'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L341-L343
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L394-L400
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L341-L343
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L394-L400
test('lintLuaScript does not warn when reset-scope creation APIs are used inside onReset', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    '  ctx:createTarget("temp", 640, 480)',
    '  ctx:createFloatBuffer("floats", { 16 })',
    '  ctx:createUIntBuffer("uints", { 16 })',
    'end',
    '',
    'function advance(ctx)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'reset_scope_creation_outside_on_reset'
  ), false);
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L505-L527
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L505-L527
test('lintLuaScript warns when compute dispatch has more than 3 dimensions', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:runComputePass("histogram", {}, { 1, 2, 3, 4 })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: [
      { id: 'histogram', type: 'compute', bindings: [] }
    ]
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_dispatch_dimension_count'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L517-L527
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L517-L527
test('lintLuaScript warns when compute dispatch has fewer than 1 dimension', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:runComputePass("histogram", {}, {})',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: [
      { id: 'histogram', type: 'compute', bindings: [] }
    ]
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_dispatch_dimension_count'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L345-L358
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L482-L488
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L507-L513
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L345-L358
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L482-L488
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L507-L513
test('lintLuaScript warns for extra, missing, and invalid uniform block binding fields', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:runComputePass("histogram", {',
    '    extra = ctx:getBuffer("scratch"),',
    '    params = { wrong = 1 }',
    '  }, { 1 })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: [
      {
        id: 'histogram',
        type: 'compute',
        bindings: [
          {
            name: 'source',
            type: 'sampledImage'
          },
          {
            name: 'params',
            type: 'uniformBlock',
            fields: [
              { name: 'exposure' }
            ]
          }
        ]
      }
    ]
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unknown_binding_name'
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'missing_binding_name'
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'missing_uniform_block_field'
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unknown_uniform_block_field'
  ));
});
