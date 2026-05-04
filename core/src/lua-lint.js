import luaparse from 'luaparse';

const CTX_METHODS = new Set([
  'getInput',
  'getParam',
  'getAsset',
  'createTarget',
  'getTarget',
  'createFloatBuffer',
  'createUIntBuffer',
  'getBuffer',
  'getOutput',
  'clearOutput',
  'runRenderPass',
  'runComputePass'
]);
const CTX_RESET_CREATION_METHODS = new Set([
  'createTarget',
  'createFloatBuffer',
  'createUIntBuffer'
]);
const TIME_METHODS = new Set([
  'now',
  'parts',
  'fromDate'
]);
const TIME_OPTIONS_FIELDS = new Set([
  'utc'
]);
const TIME_FROM_DATE_REQUIRED_FIELDS = new Set([
  'year',
  'month',
  'day'
]);
const MAT4_METHOD_ARITY = new Map([
  ['identity', [1, 1]],
  ['copy', [2, 2]],
  ['multiply', [2, 2]],
  ['preMultiply', [2, 2]],
  ['translate', [4, 4]],
  ['scale', [4, 4]],
  ['rotateX', [2, 2]],
  ['rotateY', [2, 2]],
  ['rotateZ', [2, 2]],
  ['setTranslation', [4, 4]],
  ['setScale', [4, 4]],
  ['setRotationX', [2, 2]],
  ['setRotationY', [2, 2]],
  ['setRotationZ', [2, 2]],
  ['setOrtho', [7, 7]],
  ['invert', [1, 1]],
  ['transpose', [1, 1]],
  ['transformPoint4', [5, 5]],
  ['transformPoint2', [3, 3]]
]);
const DISALLOWED_RUNTIME_GLOBALS = new Set([
  'os',
  'io',
  'package',
  'debug'
]);

/**
 * Validate Lua syntax and statically-known structural constraints.
 *
 * This pass is intentionally conservative. It only checks patterns that can be
 * determined directly from Lua syntax, such as entry function signatures,
 * method names, and table literals used inline.
 *
 * @param {string} source
 * @param {{ outputSizeMode?: string, parameters: { id: string }[], assets: { id: string }[], passes: { id: string, type: string, bindings?: object[] }[] }} symbols
 * @returns {import('./index.js').Diagnostic[]}
 */
export function lintLuaScript(source, symbols) {
  const diagnostics = [];
  let ast;

  try {
    ast = luaparse.parse(source, {
      comments: false,
      locations: true,
      luaVersion: '5.3',
      encodingMode: 'pseudo-latin1'
    });
  } catch (error) {
    diagnostics.push(luaDiagnostic(
      'lua_syntax_error',
      `main.lua syntax error: ${error.message}`,
      error.line,
      error.column
    ));
    return diagnostics;
  }

  const context = {
    diagnostics,
    outputSizeMode: symbols.outputSizeMode ?? 'passive',
    parameterById: new Map((symbols.parameters ?? []).map((parameter) => [parameter.id, parameter])),
    assetById: new Map((symbols.assets ?? []).map((asset) => [asset.id, asset])),
    passById: new Map(symbols.passes.map((pass) => [pass.id, pass])),
    entryFunctions: collectEntryFunctions(ast)
  };

  validateEntryFunctions(context);
  validateResetScopedCreationCalls(ast, context);
  walkAst(ast, (node) => {
    if (node.type === 'MemberExpression') {
      validateRuntimeMemberExpression(node, context);
    }

    if (node.type !== 'CallExpression') return;

    const ctxCall = parseCtxCall(node);
    if (ctxCall) {
      validateCtxCall(ctxCall, node, context);
      return;
    }

    const timeCall = parseTimeCall(node);
    if (timeCall) {
      validateTimeCall(timeCall, node, context);
      return;
    }

    const mat4Call = parseMat4Call(node);
    if (mat4Call) {
      validateMat4Call(mat4Call, node, context);
    }
  });

  return diagnostics;
}

function validateEntryFunctions(context) {
  validateRequiredEntryFunction(context, 'advance', ['ctx']);

  if (context.outputSizeMode === 'active') {
    validateRequiredEntryFunction(context, 'onReset', ['ctx', 'outputRequest']);
    return;
  }

  validateRequiredEntryFunction(context, 'onReset', ['ctx']);
}

function validateRequiredEntryFunction(context, name, expectedParameters) {
  const entry = context.entryFunctions.get(name);
  if (!entry) {
    context.diagnostics.push(luaDiagnostic(
      'missing_entry_function',
      `main.lua must define ${formatFunctionSignature(name, expectedParameters)}.`,
      undefined,
      undefined
    ));
    return;
  }

  const actualParameters = entry.parameters.map((parameter) => parameter.name);
  if (actualParameters.length !== expectedParameters.length) {
    context.diagnostics.push(luaDiagnostic(
      'invalid_entry_function_arity',
      `${name} must declare ${expectedParameters.length} parameter(s): ${formatFunctionSignature(name, expectedParameters)}.`,
      entry.location?.start?.line,
      entry.location?.start?.column
    ));
    return;
  }

  for (let index = 0; index < expectedParameters.length; index += 1) {
    if (actualParameters[index] !== expectedParameters[index]) {
      context.diagnostics.push(luaDiagnostic(
        'invalid_entry_function_parameter',
        `${name} parameter ${index + 1} must be "${expectedParameters[index]}". Expected ${formatFunctionSignature(name, expectedParameters)}.`,
        entry.parameters[index]?.loc?.start?.line ?? entry.location?.start?.line,
        entry.parameters[index]?.loc?.start?.column ?? entry.location?.start?.column
      ));
      return;
    }
  }
}

function collectEntryFunctions(ast) {
  const entries = new Map();

  for (const statement of ast.body ?? []) {
    if (statement.type === 'FunctionDeclaration' && statement.identifier?.type === 'Identifier') {
      recordEntryFunction(entries, statement.identifier.name, statement);
      continue;
    }

    if (statement.type === 'AssignmentStatement') {
      for (let index = 0; index < statement.variables.length; index += 1) {
        const variable = statement.variables[index];
        const init = statement.init[index];
        if (variable?.type !== 'Identifier' || init?.type !== 'FunctionDeclaration') continue;
        recordEntryFunction(entries, variable.name, init, variable.loc);
      }
    }
  }

  return entries;
}

function recordEntryFunction(entries, name, functionNode, fallbackLocation = null) {
  if (name !== 'onReset' && name !== 'advance') return;
  if (entries.has(name)) return;

  entries.set(name, {
    name,
    parameters: functionNode.parameters ?? [],
    location: functionNode.loc ?? fallbackLocation,
    node: functionNode
  });
}

function validateRuntimeMemberExpression(node, context) {
  const baseName = node.base?.type === 'Identifier' ? node.base.name : null;
  if (DISALLOWED_RUNTIME_GLOBALS.has(baseName)) {
    context.diagnostics.push(luaDiagnostic(
      'unavailable_lua_library',
      `Lua library "${baseName}" is not available in the filter runtime.`,
      node.base?.loc?.start?.line,
      node.base?.loc?.start?.column
    ));
    return;
  }

  if (baseName !== 'time' && baseName !== 'mat4') return;
  if (node.identifier?.type !== 'Identifier') return;
  if (node.indexer !== '.') {
    context.diagnostics.push(luaDiagnostic(
      `invalid_${baseName}_call_syntax`,
      `${baseName} functions must be called with dot syntax.`,
      node.identifier.loc?.start?.line,
      node.identifier.loc?.start?.column
    ));
    return;
  }

  if (baseName === 'time' && !TIME_METHODS.has(node.identifier.name)) {
    context.diagnostics.push(luaDiagnostic(
      'unknown_time_method',
      `Unknown time method: ${node.identifier.name}`,
      node.identifier.loc?.start?.line,
      node.identifier.loc?.start?.column
    ));
  }

  if (baseName === 'mat4' && !MAT4_METHOD_ARITY.has(node.identifier.name)) {
    context.diagnostics.push(luaDiagnostic(
      'unknown_mat4_method',
      `Unknown mat4 method: ${node.identifier.name}`,
      node.identifier.loc?.start?.line,
      node.identifier.loc?.start?.column
    ));
  }
}

function validateCtxCall(ctxCall, node, context) {
  const { method } = ctxCall;
  if (!CTX_METHODS.has(method)) {
    context.diagnostics.push(luaDiagnostic(
      'unknown_ctx_method',
      `Unknown ctx method: ${method}`,
      ctxCall.location?.start?.line,
      ctxCall.location?.start?.column
    ));
    return;
  }

  if (method === 'runRenderPass') {
    validateRunPass(node, context);
  }

  if (method === 'runComputePass') {
    validateRunPass(node, context);
  }

  if (method === 'getParam') {
    validateNamedRuntimeLookup(node, context, 'parameter', context.parameterById, 'unknown_parameter_id');
  }

  if (method === 'getAsset') {
    validateNamedRuntimeLookup(node, context, 'asset', context.assetById, 'unknown_asset_id');
  }
}

function validateTimeCall(timeCall, node, context) {
  if (!TIME_METHODS.has(timeCall.method)) return;

  if (timeCall.method === 'now') {
    validateArgumentCount(node, context, 'time.now', 0, 0);
    return;
  }

  if (timeCall.method === 'parts') {
    validateArgumentCount(node, context, 'time.parts', 2, 3);
    validateTimeOptions(node.arguments?.[2], context);
    return;
  }

  if (timeCall.method === 'fromDate') {
    validateArgumentCount(node, context, 'time.fromDate', 1, 2);
    validateTimeFromDateLiteral(node.arguments?.[0], context);
    validateTimeOptions(node.arguments?.[1], context);
  }
}

function validateMat4Call(mat4Call, node, context) {
  const arity = MAT4_METHOD_ARITY.get(mat4Call.method);
  if (!arity) return;

  validateArgumentCount(node, context, `mat4.${mat4Call.method}`, arity[0], arity[1]);
}

function validateArgumentCount(node, context, label, min, max) {
  const count = node.arguments?.length ?? 0;
  if (count >= min && count <= max) return;
  const expected = min === max ? String(min) : `${min} to ${max}`;
  context.diagnostics.push(luaDiagnostic(
    'unexpected_argument_count',
    `${label} expects ${expected} argument(s), but got ${count}.`,
    node.loc?.start?.line,
    node.loc?.start?.column,
    'warning'
  ));
}

function validateTimeOptions(optionsNode, context) {
  if (optionsNode?.type !== 'TableConstructorExpression') return;
  const fields = getTableStringFields(optionsNode);
  for (const [key, field] of fields.entries()) {
    if (TIME_OPTIONS_FIELDS.has(key)) continue;
    context.diagnostics.push(luaDiagnostic(
      'unknown_time_option',
      `time options have no field named "${key}".`,
      field.key?.loc?.start?.line,
      field.key?.loc?.start?.column,
      'warning'
    ));
  }
}

function validateTimeFromDateLiteral(dateNode, context) {
  if (dateNode?.type !== 'TableConstructorExpression') return;
  const fields = getTableStringFields(dateNode);
  for (const key of TIME_FROM_DATE_REQUIRED_FIELDS) {
    if (fields.has(key)) continue;
    context.diagnostics.push(luaDiagnostic(
      'missing_time_from_date_field',
      `time.fromDate date table requires field "${key}".`,
      dateNode.loc?.start?.line,
      dateNode.loc?.start?.column,
      'warning'
    ));
  }
}

function validateNamedRuntimeLookup(node, context, label, knownById, code) {
  const id = getStringLiteralValue(node.arguments?.[0]);
  if (!id || knownById.has(id)) return;
  context.diagnostics.push(luaDiagnostic(
    code,
    `Unknown ${label} id: ${id}`,
    node.arguments?.[0]?.loc?.start?.line ?? node.loc?.start?.line,
    node.arguments?.[0]?.loc?.start?.column ?? node.loc?.start?.column,
    'warning'
  ));
}

function validateRunPass(node, context) {
  const passIdNode = node.arguments?.[0];
  const passId = getStringLiteralValue(passIdNode);
  const bindingsNode = node.arguments?.[1];
  if (passId) {
    const pass = context.passById.get(passId);
    if (pass) {
      validateBindingTable(pass, bindingsNode, context);
    }
  }

  if (node.base?.identifier?.name === 'runComputePass') {
    validateDispatchDimensions(node.arguments?.[2], context);
  }
}

function validateBindingTable(pass, bindingsNode, context) {
  if (bindingsNode?.type !== 'TableConstructorExpression') return;
  if (!Array.isArray(pass.bindings)) return;

  const actualFields = getTableStringFields(bindingsNode);
  const expectedBindings = new Map((pass.bindings ?? []).map((binding) => [binding.name, binding]));

  for (const key of actualFields.keys()) {
    if (!expectedBindings.has(key)) {
      context.diagnostics.push(luaDiagnostic(
        'unknown_binding_name',
        `Pass "${pass.id}" has no reflected binding named "${key}".`,
        actualFields.get(key)?.key?.loc?.start?.line,
        actualFields.get(key)?.key?.loc?.start?.column,
        'warning'
      ));
    }
  }

  for (const [name, binding] of expectedBindings.entries()) {
    const actual = actualFields.get(name);
    if (!actual) {
      context.diagnostics.push(luaDiagnostic(
        'missing_binding_name',
        `Pass "${pass.id}" requires binding "${name}".`,
        bindingsNode.loc?.start?.line,
        bindingsNode.loc?.start?.column,
        'warning'
      ));
      continue;
    }

    if (binding.type === 'uniformBlock') {
      validateUniformBlockFields(pass, binding, actual.value, context);
    }
  }
}

function validateUniformBlockFields(pass, binding, valueNode, context) {
  if (valueNode?.type !== 'TableConstructorExpression') return;

  const actualFields = getTableStringFields(valueNode);
  const expectedFields = new Set((binding.fields ?? []).map((field) => field.name));

  for (const key of actualFields.keys()) {
    if (!expectedFields.has(key)) {
      context.diagnostics.push(luaDiagnostic(
        'unknown_uniform_block_field',
        `Pass "${pass.id}" binding "${binding.name}" has no uniform field named "${key}".`,
        actualFields.get(key)?.key?.loc?.start?.line,
        actualFields.get(key)?.key?.loc?.start?.column,
        'warning'
      ));
    }
  }

  for (const key of expectedFields) {
    if (!actualFields.has(key)) {
      context.diagnostics.push(luaDiagnostic(
        'missing_uniform_block_field',
        `Pass "${pass.id}" binding "${binding.name}" requires uniform field "${key}".`,
        valueNode.loc?.start?.line,
        valueNode.loc?.start?.column,
        'warning'
      ));
    }
  }
}

function parseCtxCall(node) {
  const base = node.base;
  if (base?.type !== 'MemberExpression') return null;
  if (base.indexer !== ':') return null;
  if (base.base?.type !== 'Identifier' || base.base.name !== 'ctx') return null;
  if (base.identifier?.type !== 'Identifier') return null;

  return {
    method: base.identifier.name,
    location: base.identifier.loc
  };
}

function parseTimeCall(node) {
  const base = node.base;
  if (base?.type !== 'MemberExpression') return null;
  if (base.base?.type !== 'Identifier' || base.base.name !== 'time') return null;
  if (base.identifier?.type !== 'Identifier') return null;

  return {
    method: base.identifier.name,
    location: base.identifier.loc
  };
}

function parseMat4Call(node) {
  const base = node.base;
  if (base?.type !== 'MemberExpression') return null;
  if (base.base?.type !== 'Identifier' || base.base.name !== 'mat4') return null;
  if (base.identifier?.type !== 'Identifier') return null;

  return {
    method: base.identifier.name,
    location: base.identifier.loc
  };
}

function getTableStringFields(tableNode) {
  const fields = new Map();
  for (const field of tableNode.fields ?? []) {
    if (field.type !== 'TableKeyString') continue;
    const key = field.key?.name;
    if (!key) continue;
    fields.set(key, field);
  }
  return fields;
}

function getStringLiteralValue(node) {
  if (node?.type !== 'StringLiteral') return null;
  return typeof node.value === 'string' ? node.value : unquoteLuaString(node.raw);
}

function unquoteLuaString(raw) {
  if (typeof raw !== 'string' || raw.length < 2) return null;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return null;
  return raw.slice(1, -1);
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);

  for (const value of Object.values(node)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        walkAst(item, visit);
      }
      continue;
    }

    if (typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit);
    }
  }
}

function validateResetScopedCreationCalls(ast, context) {
  for (const statement of ast.body ?? []) {
    const functionNode = getTopLevelFunctionNode(statement);
    if (functionNode) {
      if (functionNode.name !== 'onReset') {
        walkFunctionBody(functionNode.node, (node) => {
          validateResetScopedCreationCallNode(node, context);
        });
      }
      continue;
    }

    walkAst(statement, (node) => {
      validateResetScopedCreationCallNode(node, context);
    });
  }
}

function validateResetScopedCreationCallNode(node, context) {
  if (node?.type !== 'CallExpression') return;
  const ctxCall = parseCtxCall(node);
  if (!ctxCall || !CTX_RESET_CREATION_METHODS.has(ctxCall.method)) return;

  context.diagnostics.push(luaDiagnostic(
    'reset_scope_creation_outside_on_reset',
    `${ctxCall.method} should only be called from onReset(ctx${context.outputSizeMode === 'active' ? ', outputRequest' : ''}).`,
    ctxCall.location?.start?.line,
    ctxCall.location?.start?.column,
    'warning'
  ));
}

function validateDispatchDimensions(dispatchNode, context) {
  if (dispatchNode?.type !== 'TableConstructorExpression') return;

  const dimensionCount = dispatchNode.fields?.length ?? 0;
  if (dimensionCount >= 1 && dimensionCount <= 3) return;

  context.diagnostics.push(luaDiagnostic(
    'unexpected_dispatch_dimension_count',
    'dispatch should contain between 1 and 3 dimensions.',
    dispatchNode.loc?.start?.line,
    dispatchNode.loc?.start?.column,
    'warning'
  ));
}

function walkFunctionBody(functionNode, visit) {
  for (const statement of functionNode.body ?? []) {
    walkAst(statement, visit);
  }
}

function getTopLevelFunctionNode(statement) {
  if (statement?.type === 'FunctionDeclaration' && statement.identifier?.type === 'Identifier') {
    return {
      name: statement.identifier.name,
      node: statement
    };
  }

  if (statement?.type !== 'AssignmentStatement') return null;
  for (let index = 0; index < statement.variables.length; index += 1) {
    const variable = statement.variables[index];
    const init = statement.init[index];
    if (variable?.type !== 'Identifier' || init?.type !== 'FunctionDeclaration') continue;
    return {
      name: variable.name,
      node: init
    };
  }

  return null;
}

function luaDiagnostic(code, message, line, column, severity = 'error') {
  return {
    severity,
    code,
    message,
    path: 'main.lua',
    line,
    column
  };
}

function formatFunctionSignature(name, parameters) {
  return `${name}(${parameters.join(', ')})`;
}
