import antlr4 from 'antlr4';
import GLSLLexer from './generated/glsl/GLSLLexer.js';
import GLSLParser from './generated/glsl/GLSLParser.js';

export function parseGlslDeclaredBindings(source) {
  return parseGlslSourceInterface(source).bindings;
}

export function parseGlslDeclaredVertexInputs(source) {
  return parseGlslSourceInterface(source).vertexInputs;
}

export function parseGlslSourceInterface(source) {
  const parsed = parseTranslationUnit(source);
  if (!parsed.tree) {
    return {
      bindings: [],
      vertexInputs: [],
      diagnostics: parsed.diagnostics
    };
  }

  const tree = parsed.tree;
  const bindings = [];
  const vertexInputs = [];
  const diagnostics = [...parsed.diagnostics];

  for (const external of tree.external_declaration()) {
    const declaration = external.declaration?.();
    if (!declaration) continue;

    if (declaration.init_declarator_list()) {
      const parsed = parseInitDeclaratorDeclaration(declaration.init_declarator_list());
      bindings.push(...parsed.bindings);
      vertexInputs.push(...parsed.vertexInputs);
      continue;
    }

    if (declaration.struct_declaration_list() && declaration.type_qualifier()) {
      const parsedBlock = parseBlockDeclaration(declaration, diagnostics);
      if (parsedBlock) {
        bindings.push(parsedBlock);
      }
    }
  }

  return {
    bindings: dedupeBindings(bindings),
    vertexInputs: dedupeVertexInputs(vertexInputs),
    diagnostics
  };
}

export function reconcileBindingsWithSource(reflectedBindings, declaredBindings) {
  const declaredBySlot = new Map();
  for (const declared of declaredBindings) {
    declaredBySlot.set(`${declared.set}:${declared.binding}`, declared);
  }

  const reconciled = [];
  for (const reflected of reflectedBindings) {
    const declared = declaredBySlot.get(`${reflected.set}:${reflected.binding}`);
    if (!declared) {
      reconciled.push(normalizeCompiledBinding(reflected));
      continue;
    }

    reconciled.push(normalizeCompiledBinding({
      ...reflected,
      name: declared.name ?? reflected.name,
      type: declared.type ?? reflected.type,
      access: declared.access ?? reflected.access,
      fields: declared.type === 'uniformBlock'
        ? mergeFields(reflected.fields, declared.fields)
        : reflected.fields,
      elementType: declared.type === 'buffer'
        ? (reflected.elementType ?? declared.elementType)
        : reflected.elementType,
      valueType: declared.type === 'uniform'
        ? (reflected.valueType ?? declared.valueType)
        : reflected.valueType
    }));
  }

  return dedupeBindings(reconciled);
}

function parseTranslationUnit(source) {
  try {
    const input = new antlr4.InputStream(source);
    const lexer = new GLSLLexer(input);
    const tokens = new antlr4.CommonTokenStream(lexer);
    const parser = new GLSLParser(tokens);
    const errorListener = new CollectingErrorListener();

    lexer.removeErrorListeners();
    parser.removeErrorListeners();
    lexer.addErrorListener(errorListener);
    parser.addErrorListener(errorListener);

    const tree = parser.translation_unit();
    if (errorListener.errors.length > 0) {
      return {
        tree: null,
        diagnostics: errorListener.errors.map((error) => ({
          code: 'glsl_parse_error',
          message: `GLSL parse error at ${error.line}:${error.column}: ${error.message}`,
          line: error.line,
          column: error.column
        }))
      };
    }

    return {
      tree,
      diagnostics: []
    };
  } catch (error) {
    return {
      tree: null,
      diagnostics: [{
        code: 'glsl_parse_error',
        message: `GLSL parse error: ${error.message}`
      }]
    };
  }
}

function parseInitDeclaratorDeclaration(context) {
  const single = context.single_declaration();
  const fullySpecifiedType = single?.fully_specified_type();
  if (!fullySpecifiedType) {
    return { bindings: [], vertexInputs: [] };
  }

  const qualifiers = parseTypeQualifier(fullySpecifiedType.type_qualifier());
  const typeSpecifier = fullySpecifiedType.type_specifier();
  const typeName = extractTypeName(typeSpecifier);
  const declaredNames = [];

  if (single.typeless_declaration()) {
    declaredNames.push(parseTypelessDeclaration(single.typeless_declaration()));
  }

  for (const additional of context.typeless_declaration()) {
    declaredNames.push(parseTypelessDeclaration(additional));
  }

  const bindings = [];
  const vertexInputs = [];

  for (const declared of declaredNames) {
    if (!declared?.name) continue;

    if (qualifiers.storage === 'uniform' && qualifiers.layout.binding !== undefined) {
      bindings.push({
        set: qualifiers.layout.set ?? 0,
        binding: qualifiers.layout.binding,
        name: declared.name,
        type: classifyLooseUniformType(typeName)
      });
    }

    if (qualifiers.storage === 'in') {
      vertexInputs.push({
        name: declared.name,
        location: qualifiers.layout.location,
        typeName
      });
    }
  }

  return { bindings, vertexInputs };
}

function parseBlockDeclaration(context, diagnostics) {
  const qualifiers = parseTypeQualifier(context.type_qualifier());
  if (qualifiers.layout.binding === undefined) {
    return null;
  }

  if (qualifiers.storage !== 'uniform' && qualifiers.storage !== 'buffer') {
    return null;
  }

  const identifiers = context.IDENTIFIER();
  const blockTypeName = identifiers[0]?.getText?.() ?? null;
  const instanceName = identifiers[1]?.getText?.() ?? blockTypeName;
  if (!instanceName) {
    return null;
  }

  const members = parseStructDeclarationList(context.struct_declaration_list());

  if (qualifiers.storage === 'buffer') {
    if (members.length !== 1) {
      diagnostics.push({
        code: 'invalid_buffer_member_count',
        message: `Storage buffer "${instanceName}" must declare exactly one member.`,
        bindingName: instanceName
      });
      return null;
    }

    if (!members[0].arraySize || members[0].arraySize.length === 0) {
      diagnostics.push({
        code: 'invalid_buffer_member_shape',
        message: `Storage buffer "${instanceName}" member "${members[0].name}" must be an array.`,
        bindingName: instanceName
      });
      return null;
    }
  }

  return {
    set: qualifiers.layout.set ?? 0,
    binding: qualifiers.layout.binding,
    name: instanceName,
    type: qualifiers.storage === 'uniform' ? 'uniformBlock' : 'buffer',
    access: qualifiers.storage === 'uniform' ? 'read' : resolveBufferAccess(qualifiers),
    fields: qualifiers.storage === 'uniform'
      ? members.map((member) => ({ name: member.name, type: member.typeName }))
      : undefined,
    elementType: qualifiers.storage === 'buffer' ? members[0].typeName : undefined
  };
}

function parseStructDeclarationList(context) {
  const members = [];
  if (!context) return members;

  for (const declaration of context.struct_declaration()) {
    const typeName = extractTypeName(declaration.type_specifier());
    const qualifiers = parseTypeQualifier(declaration.type_qualifier());
    const declarators = declaration.struct_declarator_list()?.struct_declarator() ?? [];

    for (const declarator of declarators) {
      const identifier = declarator.IDENTIFIER()?.getText?.();
      if (!identifier) continue;

      members.push({
        name: identifier,
        typeName,
        qualifiers,
        arraySize: parseArraySpecifier(declarator.array_specifier())
      });
    }
  }

  return members;
}

function parseTypelessDeclaration(context) {
  return {
    name: context.IDENTIFIER()?.getText?.() ?? null,
    arraySize: parseArraySpecifier(context.array_specifier())
  };
}

function parseArraySpecifier(context) {
  if (!context) return null;

  return context.dimension().map((dimension) => {
    const expression = dimension.constant_expression();
    return expression ? expression.getText() : null;
  });
}

function parseTypeQualifier(context) {
  const layout = {};
  let storage = null;
  let readonly = false;
  let writeonly = false;

  for (const qualifier of context?.single_type_qualifier() ?? []) {
    const layoutQualifier = qualifier.layout_qualifier();
    if (layoutQualifier) {
      Object.assign(layout, parseLayoutQualifier(layoutQualifier));
    }

    const storageQualifier = qualifier.storage_qualifier();
    if (!storageQualifier) continue;

    if (storageQualifier.UNIFORM()) storage = 'uniform';
    if (storageQualifier.BUFFER()) storage = 'buffer';
    if (storageQualifier.IN()) storage = 'in';
    if (storageQualifier.OUT()) storage = 'out';
    if (storageQualifier.READONLY()) readonly = true;
    if (storageQualifier.WRITEONLY()) writeonly = true;
  }

  return {
    layout,
    storage,
    readonly,
    writeonly
  };
}

function parseLayoutQualifier(context) {
  const layout = {};

  for (const item of context.layout_qualifier_id_list()?.layout_qualifier_id() ?? []) {
    if (item.SHARED()) {
      layout.shared = true;
      continue;
    }

    const identifier = item.IDENTIFIER()?.getText?.();
    if (!identifier) continue;

    const valueText = item.constant_expression()?.getText?.();
    layout[identifier] = valueText === undefined ? true : parseConstantValue(valueText);
  }

  return layout;
}

function parseConstantValue(valueText) {
  if (/^[0-9]+u?$/i.test(valueText)) {
    return Number.parseInt(valueText, 10);
  }

  if (/^-?[0-9]+$/.test(valueText)) {
    return Number.parseInt(valueText, 10);
  }

  return valueText;
}

function extractTypeName(typeSpecifier) {
  if (!typeSpecifier) return null;

  const nonArray = typeSpecifier.type_specifier_nonarray();
  const structSpecifier = nonArray?.struct_specifier?.();
  if (structSpecifier) {
    return structSpecifier.IDENTIFIER()?.getText?.() ?? 'struct';
  }

  return nonArray?.getText?.() ?? null;
}

function classifyLooseUniformType(typeName) {
  if (!typeName) return 'uniform';
  if (typeName.startsWith('sampler')) return 'sampledImage';
  if (typeName.includes('image')) return 'image';
  return 'uniform';
}

function resolveBufferAccess(qualifiers) {
  if (qualifiers.readonly) return 'read';
  if (qualifiers.writeonly) return 'write';
  return 'readWrite';
}

function mergeFields(reflectedFields, declaredFields) {
  if (!declaredFields?.length) {
    return reflectedFields;
  }

  return declaredFields.map((declaredField, index) => {
    const reflectedField = reflectedFields?.[index] ?? {};
    return {
      ...reflectedField,
      name: declaredField.name,
      type: reflectedField.type ?? declaredField.type
    };
  });
}

function normalizeCompiledBinding(binding) {
  const normalized = {
    set: binding.set,
    binding: binding.binding,
    name: binding.name,
    type: binding.type
  };

  if (binding.type === 'buffer') {
    normalized.access = binding.access;
    normalized.elementType = binding.elementType;
  }

  if (binding.type === 'uniformBlock') {
    if (binding.access !== undefined) {
      normalized.access = binding.access;
    }
    normalized.fields = binding.fields;
  }

  if (binding.type === 'uniform') {
    normalized.valueType = binding.valueType;
  }

  return normalized;
}

function dedupeBindings(bindings) {
  const result = [];
  const seen = new Set();

  for (const binding of bindings) {
    const key = `${binding.set}:${binding.binding}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(binding);
  }

  return result.sort((a, b) => {
    if (a.set !== b.set) return a.set - b.set;
    return a.binding - b.binding;
  });
}

function dedupeVertexInputs(vertexInputs) {
  const result = [];
  const seen = new Set();

  for (const input of vertexInputs) {
    const key = `${input.location ?? 'unknown'}:${input.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(input);
  }

  return result.sort((a, b) => {
    if (a.location === undefined) return 1;
    if (b.location === undefined) return -1;
    return a.location - b.location;
  });
}

class CollectingErrorListener {
  constructor() {
    this.errors = [];
  }

  syntaxError(recognizer, offendingSymbol, line, column, message) {
    this.errors.push({ line, column, message });
  }

  reportAmbiguity() {}

  reportAttemptingFullContext() {}

  reportContextSensitivity() {}
}
