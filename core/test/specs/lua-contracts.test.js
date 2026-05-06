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

test('lintLuaScript accepts clearOutput ctx method', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:clearOutput(ctx:getOutput(), { 0.1, 0.1, 0.12, 1.0 })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unknown_ctx_method'
  ), false);
});

test('lintLuaScript accepts render timeline ctx methods', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local frame = ctx:getFrameIndex()',
    '  local t = ctx:getTimeSeconds()',
    '  local dt = ctx:getDeltaSeconds()',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unknown_ctx_method'
  ), false);
  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ), false);
});

test('lintLuaScript warns on render timeline ctx method arguments', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  ctx:getTimeSeconds(1)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ));
});

test('lintLuaScript warns on unknown literal parameter and asset lookups', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local exposure = ctx:getParam("exposure")',
    '  local missingParam = ctx:getParam("missingParam")',
    '  local logo = ctx:getAsset("logo")',
    '  local missingAsset = ctx:getAsset("missingAsset")',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [
      { id: 'exposure' }
    ],
    assets: [
      { id: 'logo' }
    ],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning'
    && item.code === 'unknown_parameter_id'
    && item.message.includes('missingParam')
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning'
    && item.code === 'unknown_asset_id'
    && item.message.includes('missingAsset')
  ));
  assert.equal(diagnostics.some((item) =>
    item.message.includes('exposure') || item.message.includes('logo')
  ), false);
});

test('lintLuaScript does not validate dynamic parameter and asset lookups', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local id = getRuntimeId()',
    '  local value = ctx:getParam(id)',
    '  local asset = ctx:getAsset(id)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && (
      item.code === 'unknown_parameter_id'
      || item.code === 'unknown_asset_id'
    )
  ), false);
});

test('lintLuaScript accepts time runtime library calls', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local wall = {}',
    '  local now = time.now()',
    '  time.parts(wall, now, { utc = true })',
    '  local launchAt = time.fromDate({ year = 2026, month = 5, day = 4, millis = 250 }, { utc = true })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'error' && (
      item.code === 'unknown_time_method'
      || item.code === 'invalid_time_call_syntax'
      || item.code === 'unavailable_lua_library'
    )
  ), false);
  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && (
      item.code === 'unexpected_argument_count'
      || item.code === 'unknown_time_option'
      || item.code === 'missing_time_from_date_field'
    )
  ), false);
});

test('lintLuaScript errors on unavailable Lua runtime libraries', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local now = os.time()',
    '  io.open("out.txt")',
    '  package.path = ""',
    '  debug.traceback()',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  const unavailable = diagnostics.filter((item) =>
    item.severity === 'error' && item.code === 'unavailable_lua_library'
  );
  assert.equal(unavailable.length, 4);
});

test('lintLuaScript validates time method names and call syntax', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time:now()',
    '  time.format(time.now())',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_time_call_syntax'
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unknown_time_method'
  ));
});

test('lintLuaScript warns on invalid time.now argument count', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.now(1)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ));
});

test('lintLuaScript validates time.parts argument counts', () => {
  const missingTimestampDiagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.parts({})',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(missingTimestampDiagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ));

  const extraArgumentDiagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.parts({}, time.now(), { utc = true }, true)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(extraArgumentDiagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ));
});

test('lintLuaScript validates time.parts options literal fields', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.parts({}, time.now(), { utc = true, zone = "utc" })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unknown_time_option'
  ));
});

test('lintLuaScript validates time.fromDate argument counts', () => {
  const missingDateDiagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.fromDate()',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(missingDateDiagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ));

  const extraArgumentDiagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.fromDate({ year = 2026, month = 5, day = 4 }, { utc = true }, true)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(extraArgumentDiagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ));
});

test('lintLuaScript validates required time.fromDate literal fields individually', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.fromDate({ year = 2026 })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  const missingFields = diagnostics.filter((item) =>
    item.severity === 'warning' && item.code === 'missing_time_from_date_field'
  );
  assert.equal(missingFields.length, 2);
  assert.ok(missingFields.some((item) => item.message.includes('"month"')));
  assert.ok(missingFields.some((item) => item.message.includes('"day"')));
});

test('lintLuaScript accepts optional and derived time.fromDate literal fields', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.fromDate({',
    '    year = 2026,',
    '    month = 5,',
    '    day = 4,',
    '    hour = 20,',
    '    min = 30,',
    '    sec = 12,',
    '    millis = 345,',
    '    wday = 1,',
    '    yday = 124',
    '  }, { utc = true })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'missing_time_from_date_field'
  ), false);
  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unknown_time_option'
  ), false);
});

test('lintLuaScript validates time.fromDate options literal fields', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  time.fromDate({ year = 2026, month = 5, day = 4 }, { utc = true, offset = 0 })',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unknown_time_option'
  ));
});

test('lintLuaScript does not validate dynamic time tables as literals', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local options = getOptions()',
    '  local date = getDate()',
    '  time.parts({}, time.now(), options)',
    '  time.fromDate(date, options)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && (
      item.code === 'unknown_time_option'
      || item.code === 'missing_time_from_date_field'
    )
  ), false);
});

test('lintLuaScript accepts documented mat4 runtime library calls', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local m = {}',
    '  local n = {}',
    '  mat4.identity(m)',
    '  mat4.copy(m, n)',
    '  mat4.multiply(m, n)',
    '  mat4.preMultiply(m, n)',
    '  mat4.translate(m, 1, 2, 3)',
    '  mat4.scale(m, 1, 2, 3)',
    '  mat4.rotateX(m, 0.25)',
    '  mat4.rotateY(m, 0.25)',
    '  mat4.rotateZ(m, 0.25)',
    '  mat4.setTranslation(m, 1, 2, 3)',
    '  mat4.setScale(m, 1, 2, 3)',
    '  mat4.setRotationX(m, 0.25)',
    '  mat4.setRotationY(m, 0.25)',
    '  mat4.setRotationZ(m, 0.25)',
    '  mat4.setOrtho(m, -1, 1, -1, 1, 0.1, 10)',
    '  mat4.invert(m)',
    '  mat4.transpose(m)',
    '  local x, y, z, w = mat4.transformPoint4(m, 1, 2, 3, 1)',
    '  local px, py = mat4.transformPoint2(m, 1, 2)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.equal(diagnostics.some((item) =>
    item.severity === 'error' && (
      item.code === 'unknown_mat4_method'
      || item.code === 'invalid_mat4_call_syntax'
    )
  ), false);
  assert.equal(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  ), false);
});

test('lintLuaScript validates mat4 method names and call syntax', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local m = {}',
    '  mat4:identity(m)',
    '  mat4.lookAt(m)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_mat4_call_syntax'
  ));
  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unknown_mat4_method'
  ));
});

test('lintLuaScript validates mat4 argument counts by documented arity', () => {
  const diagnostics = lintLuaScript([
    'function onReset(ctx)',
    'end',
    '',
    'function advance(ctx)',
    '  local m = {}',
    '  local n = {}',
    '  mat4.identity()',
    '  mat4.copy(m)',
    '  mat4.translate(m, 1, 2)',
    '  mat4.setOrtho(m, -1, 1, -1, 1, 0.1)',
    '  mat4.transformPoint4(m, 1, 2, 3)',
    '  mat4.transformPoint2(m, 1)',
    '  mat4.rotateX(m, 0.25, 1)',
    'end',
    ''
  ].join('\n'), {
    outputSizeMode: 'passive',
    parameters: [],
    assets: [],
    passes: []
  });

  const argumentWarnings = diagnostics.filter((item) =>
    item.severity === 'warning' && item.code === 'unexpected_argument_count'
  );
  assert.equal(argumentWarnings.length, 7);
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.identity expects 1')));
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.copy expects 2')));
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.translate expects 4')));
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.setOrtho expects 7')));
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.transformPoint4 expects 5')));
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.transformPoint2 expects 3')));
  assert.ok(argumentWarnings.some((item) => item.message.includes('mat4.rotateX expects 2')));
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
