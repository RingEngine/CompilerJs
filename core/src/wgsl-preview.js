const GLSL_TYPE_PATTERN = 'bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4';
const GLSL_TYPE_DECL_RE = new RegExp(String.raw`\b(${GLSL_TYPE_PATTERN})\s+([A-Za-z_][A-Za-z0-9_]*)\s*=`, 'g');
const GLSL_FUNCTION_DECL_RE = new RegExp(String.raw`\b(${GLSL_TYPE_PATTERN})\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{`, 'g');
const GLSL_ARG_RE = new RegExp(String.raw`^\s*(${GLSL_TYPE_PATTERN})\s+([A-Za-z_][A-Za-z0-9_]*)\s*$`);
const GLSL_IO_RE = (direction) => new RegExp(
  String.raw`\blayout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*${direction}\s+(${GLSL_TYPE_PATTERN})\s+([A-Za-z_][A-Za-z0-9_]*)\s*;`,
  'g'
);

export function translateRenderPassToWgsl({ pass, vertexSource, fragmentSource, vertexLineMap = [], fragmentLineMap = [] }) {
  const sampledImages = (pass.bindings ?? []).filter((binding) => binding.type === 'sampledImage');
  const bufferMembers = new Map(
    (pass.bindings ?? [])
      .filter((binding) => binding.type === 'buffer')
      .map((binding) => [binding.name, findBufferArrayMember(fragmentSource, binding.name) ?? 'values'])
  );

  const vertex = stripGlslDirectives(vertexSource);
  const fragmentInputs = parseShaderIoDeclarations(fragmentSource, 'in');
  const vertexOutputs = parseShaderIoDeclarations(vertexSource, 'out');
  const varyings = matchRenderVaryings(vertexOutputs, fragmentInputs);
  const vertexBody = translateRenderVertexBody(createMappedSource(vertex, vertexLineMap), varyings);

  let fragment = createMappedSource(stripGlslDirectives(fragmentSource), fragmentLineMap);
  fragment = mapSourceCode(fragment, translateRenderDefines);
  fragment = removeRenderBindingDeclarationsMapped(fragment, pass);
  fragment = mapSourceCode(fragment, (code) => translateFragmentInputReferences(code, varyings));
  fragment = mapSourceCode(fragment, (code) => translateUniformBoolFieldReferences(code, pass));
  fragment = translateRenderTextureFetchesMapped(fragment, sampledImages);
  fragment = mapSourceCode(fragment, (code) => translateBufferAccess(code, pass, bufferMembers));
  const splitFragment = splitShaderMainMapped(fragment);
  const translatedHelpers = mapSourceCode(splitFragment.helpers, translateRenderSyntax);
  const translatedBody = mapSourceCode(splitFragment.mainBody, translateRenderBodySyntax);
  return buildRenderWgsl(pass, varyings, vertexBody, translatedHelpers, translatedBody);
}

export function translateComputePassToWgsl({ pass, source, lineMap = [] }) {
  const declarations = buildComputeBindingDeclarations(pass);
  const entryHeader = buildComputeEntryHeader(pass);
  const sampledImages = (pass.bindings ?? []).filter((binding) => binding.type === 'sampledImage');
  const bufferMembers = new Map(
    (pass.bindings ?? [])
      .filter((binding) => binding.type === 'buffer')
      .map((binding) => [binding.name, findBufferArrayMember(source, binding.name) ?? 'values'])
  );

  let translated = createMappedSource(stripGlslDirectives(source), lineMap);
  translated = mapSourceCode(translated, translateDefines);
  translated = mapSourceCode(translated, (code) => removeComputeBindingDeclarations(code, pass));
  translated = mapSourceCode(translated, (code) => translateUniformBoolFieldReferences(code, pass));
  translated = mapSourceCode(translated, (code) => translateTextureFetches(code, sampledImages));
  translated = mapSourceCode(translated, (code) => translateBufferAccess(code, pass, bufferMembers));
  const splitCompute = splitShaderMainMapped(translated);
  const translatedHelpers = mapSourceCode(splitCompute.helpers, translateComputeSyntax);
  const translatedBody = mapSourceCode(splitCompute.mainBody, translateComputeBodySyntax);

  const builder = createMappedCodeBuilder();
  builder.addGenerated(declarations);
  if (translatedHelpers.code.trim()) {
    builder.addMapped(trimMappedSource(translatedHelpers));
  }
  builder.addGenerated(entryHeader);
  if (translatedBody.code.trim()) {
    builder.addMapped(trimMappedSource(translatedBody));
  }
  builder.addGenerated('}');
  return builder.build();
}

function buildRenderWgsl(pass, varyings, vertexBody = '', helperCode = '', bodyCode = '') {
  const builder = createMappedCodeBuilder();
  builder.addGenerated('struct VertexOut {');
  builder.addGenerated('  @builtin(position) position: vec4<f32>,');
  for (const varying of varyings) {
    builder.addGenerated(`  @location(${varying.location}) ${varying.fragmentName}: ${toWgslType(varying.type)},`);
  }
  builder.addGenerated([
    '};',
    '@vertex',
    'fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {',
    '  var positions = array<vec2<f32>, 3>(',
    '    vec2<f32>(-1.0, -1.0),',
    '    vec2<f32>(3.0, -1.0),',
    '    vec2<f32>(-1.0, 3.0)',
    '  );',
    '  var out: VertexOut;',
    '  let pos = positions[vertexIndex];',
    ...varyings.map((varying) => `  var ${varying.vertexName}: ${toWgslType(varying.type)};`),
    '  out.position = vec4<f32>(pos, 0.0, 1.0);',
    ...buildDefaultVaryingInitializers(varyings)
  ]);
  builder.addMapped(vertexBody, '  ');
  builder.addGenerated([
    ...varyings.map((varying) => `  out.${varying.fragmentName} = ${varying.vertexName};`),
    '  return out;',
    '}',
    ''
  ]);

  for (const binding of pass.bindings ?? []) {
    addWgslBindingDeclaration(builder, binding, true);
  }

  if (helperCode.code.trim()) {
    builder.addMapped(trimMappedSource(helperCode));
  }
  builder.addGenerated('@fragment');
  builder.addGenerated('fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {');
  if (bodyCode.code.trim()) {
    builder.addMapped(trimMappedSource(bodyCode));
  }
  builder.addGenerated('}');
  return builder.build();
}

function addWgslBindingDeclaration(builder, binding, renderStage = false) {
  const prefix = `@group(${binding.set ?? 0}) @binding(${binding.binding})`;
  if (binding.type === 'sampledImage') {
    builder.addGenerated(`${prefix} var ${binding.name}: texture_2d<f32>;`);
    return;
  }
  if (binding.type === 'buffer') {
    const elementType = binding.elementType === 'uint' ? 'u32' : 'f32';
    const mode = binding.access === 'read' || renderStage ? 'read' : 'read_write';
    const storageType = binding.access === 'readWrite' && binding.elementType === 'uint' && !renderStage
      ? `array<atomic<${elementType}>>`
      : `array<${elementType}>`;
    builder.addGenerated(`${prefix} var<storage, ${mode}> ${binding.name}: ${storageType};`);
    return;
  }
  if (binding.type === 'uniformBlock') {
    builder.addGenerated(`struct ${binding.name}_Block {`);
    for (const field of binding.fields ?? []) {
      builder.addGenerated(`  ${formatUniformBlockField(field)}`);
    }
    builder.addGenerated('};');
    builder.addGenerated(`${prefix} var<uniform> ${binding.name}: ${binding.name}_Block;`);
  }
}

function formatUniformBlockField(field) {
  const attrs = [];
  const align = uniformFieldAlign(field.type);
  const size = field.size ?? uniformFieldSize(field.type);
  if (align > naturalWgslAlign(field.type)) attrs.push(`@align(${align})`);
  if (size > naturalWgslSize(field.type)) attrs.push(`@size(${size})`);
  const prefix = attrs.length > 0 ? `${attrs.join(' ')} ` : '';
  return `${prefix}${field.name}: ${toWgslUniformFieldType(field.type)},`;
}

function uniformFieldAlign(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'vec4' || type === 'ivec3' || type === 'ivec4' || type === 'uvec3' || type === 'uvec4') return 16;
  if (type === 'mat2' || type === 'mat3' || type === 'mat4') return 16;
  return 4;
}

function uniformFieldSize(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'vec4' || type === 'ivec3' || type === 'ivec4' || type === 'uvec3' || type === 'uvec4') return 16;
  if (type === 'mat2') return 32;
  if (type === 'mat3') return 48;
  if (type === 'mat4') return 64;
  return 4;
}

function naturalWgslAlign(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'vec4' || type === 'ivec3' || type === 'ivec4' || type === 'uvec3' || type === 'uvec4') return 16;
  if (type === 'mat3' || type === 'mat4') return 16;
  if (type === 'mat2') return 8;
  return 4;
}

function naturalWgslSize(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'ivec3' || type === 'uvec3') return 12;
  if (type === 'vec4' || type === 'ivec4' || type === 'uvec4') return 16;
  if (type === 'mat2') return 16;
  if (type === 'mat3') return 48;
  if (type === 'mat4') return 64;
  return 4;
}

function buildComputeBindingDeclarations(pass) {
  const builder = createMappedCodeBuilder();
  for (const binding of pass.bindings ?? []) {
    addWgslBindingDeclaration(builder, binding, false);
  }
  return builder.build().code;
}

function buildComputeEntryHeader(pass) {
  const localSize = pass.localSize ?? {};
  return [
    `@compute @workgroup_size(${localSize.x ?? 1}, ${localSize.y ?? 1}, ${localSize.z ?? 1})`,
    'fn main(',
    '  @builtin(global_invocation_id) global_id: vec3<u32>,',
    '  @builtin(local_invocation_index) local_index: u32',
    ') {'
  ].join('\n');
}

function parseShaderIoDeclarations(source, direction) {
  const declarations = [];
  const pattern = GLSL_IO_RE(direction);
  let match;
  while ((match = pattern.exec(String(source)))) {
    declarations.push({
      location: Number(match[1]),
      type: match[2],
      name: match[3]
    });
  }
  return declarations.sort((left, right) => left.location - right.location);
}

function matchRenderVaryings(vertexOutputs, fragmentInputs) {
  if (fragmentInputs.length === 0) {
    return [{ location: 0, type: 'vec2', vertexName: 'v_uv', fragmentName: 'v_uv' }];
  }
  return fragmentInputs.map((input) => {
    const output = vertexOutputs.find((candidate) => candidate.location === input.location)
      ?? vertexOutputs.find((candidate) => candidate.name === input.name)
      ?? input;
    return {
      location: input.location,
      type: input.type,
      vertexName: output.name,
      fragmentName: input.name
    };
  });
}

function translateRenderVertexBody(source, varyings) {
  const splitVertex = splitShaderMainMapped(source);
  let body = mapSourceCode(splitVertex.mainBody, (code) => code
    .replace(/\bgl_Position\s*=\s*[^;]+;\s*/g, (match) => blankPreservingLineCount(match))
    .replace(/\ba_position\b/g, 'pos')
    .replace(/\bpos\s*\*\s*0\.5\s*\+\s*0\.5\b/g, 'pos * 0.5 + vec2<f32>(0.5)'));
  for (const varying of varyings) {
    if (varying.vertexName !== varying.fragmentName) {
      body = mapSourceCode(body, (code) => code.replace(
        new RegExp(String.raw`\b${escapeRegExp(varying.fragmentName)}\b\s*=`, 'g'),
        `${varying.vertexName} =`
      ));
    }
  }
  return trimMappedSource(mapSourceCode(body, translateRenderSyntax));
}

function translateFragmentInputReferences(source, varyings) {
  let result = source;
  for (const varying of varyings) {
    result = result.replace(
      new RegExp(String.raw`(?<!\.)\b${escapeRegExp(varying.fragmentName)}\b`, 'g'),
      `in.${varying.fragmentName}`
    );
  }
  return result;
}

function translateUniformBoolFieldReferences(source, pass) {
  let result = source;
  for (const binding of pass.bindings ?? []) {
    if (binding.type !== 'uniformBlock') continue;
    for (const field of binding.fields ?? []) {
      if (field.type !== 'bool') continue;
      result = result.replace(
        new RegExp(String.raw`\b${escapeRegExp(binding.name)}\s*\.\s*${escapeRegExp(field.name)}\b`, 'g'),
        `(${binding.name}.${field.name} != 0u)`
      );
    }
  }
  return result;
}

function translateRenderTextureFetchesMapped(source, sampledImages) {
  let result = source;
  for (const binding of sampledImages) {
    result = mapSourceCode(result, (code) => code.replace(
      new RegExp(String.raw`texture\s*\(\s*${binding.name}\s*,\s*([^)]+)\)`, 'g'),
      `sampleImage_${binding.name}($1)`
    ));
    const helperLines = [
      `fn sampleImage_${binding.name}(uv: vec2<f32>) -> vec4<f32> {`,
      `  let dims = textureDimensions(${binding.name});`,
      '  let width = u32(max(dims.x, 1));',
      '  let height = u32(max(dims.y, 1));',
      '  let x = min(u32(clamp(uv.x, 0.0, 1.0) * f32(max(width - 1u, 1u))), max(width - 1u, 0u));',
      '  let y = min(u32(clamp(1.0 - uv.y, 0.0, 1.0) * f32(max(height - 1u, 1u))), max(height - 1u, 0u));',
      `  return textureLoad(${binding.name}, vec2<i32>(i32(x), i32(y)), 0);`,
      '}'
    ];
    result = {
      code: [...helperLines, result.code].join('\n'),
      lineMap: [...Array(helperLines.length).fill(null), ...result.lineMap]
    };
  }
  return result;
}

function translateTextureFetches(source, sampledImages) {
  let result = source;
  for (const binding of sampledImages) {
    let needsTexelFetchHelper = false;
    result = result.replace(
      new RegExp(String.raw`textureSize\s*\(\s*${binding.name}\s*,\s*0\s*\)`, 'g'),
      `vec2<i32>(i32(textureDimensions(${binding.name}).x), i32(textureDimensions(${binding.name}).y))`
    );
    result = result.replace(
      new RegExp(String.raw`texelFetch\s*\(\s*${binding.name}\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*0\s*\)\s*\.rgb`, 'g'),
      (_, coord) => {
        needsTexelFetchHelper = true;
        return `loadTexel_${binding.name}(${coord}).rgb`;
      }
    );
    if (needsTexelFetchHelper) {
      result = [
        `fn loadTexel_${binding.name}(coord: vec2<i32>) -> vec4<f32> {`,
        `  let dims = textureDimensions(${binding.name});`,
        '  let width = i32(max(dims.x, 1));',
        '  let height = i32(max(dims.y, 1));',
        '  let x = clamp(coord.x, 0, width - 1);',
        '  let y = clamp(height - 1 - coord.y, 0, height - 1);',
        `  return textureLoad(${binding.name}, vec2<i32>(x, y), 0);`,
        '}',
        result
      ].join('\n');
    }
  }
  return result;
}

function translateBufferAccess(source, pass, bufferMembers) {
  let result = source;
  for (const binding of pass.bindings ?? []) {
    if (binding.type !== 'buffer') continue;
    const member = bufferMembers.get(binding.name);
    const accessPattern = `${binding.name}\\s*\\.\\s*${member}\\s*\\[\\s*([^\\]]+)\\s*\\]`;
    if (binding.access === 'readWrite' && binding.elementType === 'uint') {
      result = result.replace(
        new RegExp(String.raw`atomicAdd\s*\(\s*${accessPattern}\s*,\s*([^)]+)\)`, 'g'),
        `atomicAdd(&${binding.name}[$1], $2)`
      );
      result = result.replace(
        new RegExp(String.raw`${accessPattern}\s*=\s*([^;]+);`, 'g'),
        `atomicStore(&${binding.name}[$1], $2);`
      );
      result = result.replace(new RegExp(accessPattern, 'g'), `atomicLoad(&${binding.name}[$1])`);
    } else {
      result = result.replace(new RegExp(accessPattern, 'g'), `${binding.name}[$1]`);
    }
  }
  return result;
}

function translateRenderSyntax(source) {
  return translateCommonSyntax(source)
    .replace(
      /clamp\s*\(\s*(sourceColor\.rgb\s*\*\s*[A-Za-z_][A-Za-z0-9_]*)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/g,
      'clamp($1, vec3<f32>($2), vec3<f32>($3))'
    )
    .replace(/\+\+([A-Za-z_][A-Za-z0-9_]*)/g, '$1 = $1 + 1')
    .replace(/for\s*\(\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(i32|u32)\s*=\s*([^;]+);\s*([^;]+);\s*\1\s*=\s*\1\s*\+\s*1\s*\)/g, 'for (var $1: $2 = $3; $4; $1 = $1 + 1)')
    .replace(/for\s*\(\s*int\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*([^;]+);\s*\+\+\1\s*\)/g, 'for (var $1: i32 = $2; $3; $1 = $1 + 1)')
    .replace(/for\s*\(\s*uint\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*([^;]+);\s*\+\+\1\s*\)/g, 'for (var $1: u32 = $2; $3; $1 = $1 + 1u)');
}

function translateRenderBodySyntax(source) {
  return translateRenderSyntax(source)
    .replace(/\boutColor\s*=\s*/g, 'return ');
}

function translateComputeSyntax(source) {
  return translateCommonSyntax(source)
    .replace(/\buint\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, 'u32 $1)')
    .replace(/\bfloat\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, 'f32 $1)')
    .replace(/\bvec3\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, 'vec3<f32> $1)')
    .replace(/\bgl_GlobalInvocationID\b/g, 'global_id')
    .replace(/\bgl_LocalInvocationIndex\b/g, 'local_index')
    .replace(/\+\+([A-Za-z_][A-Za-z0-9_]*)/g, '$1 = $1 + 1u')
    .replace(/for\s*\(\s*uint\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*([^;]+);\s*\+\+\1\s*\)/g, 'for (var $1 = $2; $3; $1 = $1 + 1u)');
}

function translateComputeBodySyntax(source) {
  return translateComputeSyntax(source);
}

function translateCommonSyntax(source) {
  return source
    .replace(GLSL_TYPE_DECL_RE, (_, type, name) => `var ${name}: ${toWgslType(type)} =`)
    .replace(GLSL_FUNCTION_DECL_RE, (_, returnType, name, args) =>
      `fn ${name}(${translateFunctionArgs(args)}) -> ${toWgslType(returnType)} {`
    )
    .replace(/\bbool\s*\(/g, 'bool(')
    .replace(/\bfloat\s*\(/g, 'f32(')
    .replace(/\buint\s*\(/g, 'u32(')
    .replace(/\bint\s*\(/g, 'i32(')
    .replace(/\bivec2\s*\(/g, 'vec2<i32>(')
    .replace(/\bivec3\s*\(/g, 'vec3<i32>(')
    .replace(/\bivec4\s*\(/g, 'vec4<i32>(')
    .replace(/\buvec2\s*\(/g, 'vec2<u32>(')
    .replace(/\buvec3\s*\(/g, 'vec3<u32>(')
    .replace(/\buvec4\s*\(/g, 'vec4<u32>(')
    .replace(/\bvec2\s*\(/g, 'vec2<f32>(')
    .replace(/\bvec3\s*\(/g, 'vec3<f32>(')
    .replace(/\bvec4\s*\(/g, 'vec4<f32>(')
    .replace(/\bmat2\s*\(/g, 'mat2x2<f32>(')
    .replace(/\bmat3\s*\(/g, 'mat3x3<f32>(')
    .replace(/\bmat4\s*\(/g, 'mat4x4<f32>(');
}

function translateFunctionArgs(args) {
  if (!args.trim()) return '';
  return args.split(',').map((arg) => {
    const match = GLSL_ARG_RE.exec(arg);
    if (!match) return arg.trim();
    return `${match[2]}: ${toWgslType(match[1])}`;
  }).join(', ');
}

function toWgslType(type) {
  if (type === 'bool') return 'bool';
  if (type === 'float') return 'f32';
  if (type === 'uint') return 'u32';
  if (type === 'int') return 'i32';
  if (type === 'vec2') return 'vec2<f32>';
  if (type === 'vec3') return 'vec3<f32>';
  if (type === 'vec4') return 'vec4<f32>';
  if (type === 'ivec2') return 'vec2<i32>';
  if (type === 'ivec3') return 'vec3<i32>';
  if (type === 'ivec4') return 'vec4<i32>';
  if (type === 'uvec2') return 'vec2<u32>';
  if (type === 'uvec3') return 'vec3<u32>';
  if (type === 'uvec4') return 'vec4<u32>';
  if (type === 'mat2') return 'mat2x2<f32>';
  if (type === 'mat3') return 'mat3x3<f32>';
  if (type === 'mat4') return 'mat4x4<f32>';
  return type;
}

function toWgslUniformFieldType(type) {
  return type === 'bool' ? 'u32' : toWgslType(type);
}

function defaultWgslValue(type) {
  if (type === 'bool') return 'false';
  if (type === 'float') return '0.0';
  if (type === 'uint') return '0u';
  if (type === 'int') return '0';
  if (type === 'vec2') return 'vec2<f32>(0.0)';
  if (type === 'vec3') return 'vec3<f32>(0.0)';
  if (type === 'vec4') return 'vec4<f32>(0.0)';
  if (type === 'ivec2') return 'vec2<i32>(0)';
  if (type === 'ivec3') return 'vec3<i32>(0)';
  if (type === 'ivec4') return 'vec4<i32>(0)';
  if (type === 'uvec2') return 'vec2<u32>(0u)';
  if (type === 'uvec3') return 'vec3<u32>(0u)';
  if (type === 'uvec4') return 'vec4<u32>(0u)';
  return `${toWgslType(type)}()`;
}

function translateDefines(source) {
  return source.replace(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*$/gm, 'const $1: u32 = $2u;');
}

function translateRenderDefines(source) {
  return source.replace(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*$/gm, 'const $1 = $2;');
}

function removeRenderBindingDeclarationsMapped(source, pass) {
  let result = mapSourceCode(source, (code) => code
    .replace(
      new RegExp(String.raw`\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*in\s+(?:${GLSL_TYPE_PATTERN})\s+[A-Za-z_][A-Za-z0-9_]*\s*;\s*`, 'g'),
      blankPreservingLineCount
    )
    .replace(
      /\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\s+vec4\s+outColor\s*;\s*/g,
      blankPreservingLineCount
    ));
  for (const binding of pass.bindings ?? []) {
    result = removeBindingDeclarationMapped(result, binding);
  }
  return result;
}

function removeBindingDeclarationMapped(source, binding) {
  if (binding.type === 'sampledImage') {
    return mapSourceCode(source, (code) => code.replace(
      new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+sampler2D\s+${binding.name}\s*;\s*`, 'g'),
      blankPreservingLineCount
    ));
  }
  if (binding.type === 'buffer') {
    return mapSourceCode(source, (code) => code.replace(
      new RegExp(String.raw`layout\s*\([^)]*\)\s*(?:readonly\s+)?buffer\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
      blankPreservingLineCount
    ));
  }
  if (binding.type === 'uniformBlock') {
    return mapSourceCode(source, (code) => code.replace(
      new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
      blankPreservingLineCount
    ));
  }
  return source;
}

function removeComputeBindingDeclarations(source, pass) {
  let result = source.replace(/layout\s*\(\s*local_size_[^)]+\)\s*in\s*;\s*/g, '');
  for (const binding of pass.bindings ?? []) {
    if (binding.type === 'sampledImage') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+sampler2D\s+${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
    if (binding.type === 'buffer') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*\)\s*(?:readonly\s+)?buffer\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
    if (binding.type === 'uniformBlock') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
  }
  return result;
}

function splitShaderMainMapped(source) {
  const match = /\bvoid\s+main\s*\(\s*\)\s*\{/.exec(source.code);
  if (!match) return { helpers: source, mainBody: createMappedSource('', []) };
  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let cursor = bodyStart;
  while (cursor < source.code.length && depth > 0) {
    const char = source.code[cursor];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    cursor += 1;
  }
  const helpersCode = source.code.slice(0, match.index);
  const bodyCode = source.code.slice(bodyStart, Math.max(bodyStart, cursor - 1));
  return {
    helpers: sliceMappedSource(source, 0, helpersCode.length),
    mainBody: sliceMappedSource(source, bodyStart, bodyStart + bodyCode.length)
  };
}

function sliceMappedSource(source, startOffset, endOffset) {
  const before = source.code.slice(0, startOffset);
  const slice = source.code.slice(startOffset, endOffset);
  const startLine = countNewlines(before);
  const lineCount = splitLines(slice).length;
  return {
    code: slice,
    lineMap: source.lineMap.slice(startLine, startLine + lineCount)
  };
}

function createMappedSource(code, lineMap = []) {
  return {
    code: String(code ?? ''),
    lineMap: normalizeLineMap(String(code ?? ''), lineMap)
  };
}

function normalizeLineMap(code, lineMap = []) {
  const lineCount = splitLines(code).length;
  return Array.from({ length: lineCount }, (_, index) => lineMap[index] ?? null);
}

function mapSourceCode(source, transform) {
  const nextCode = transform(source.code);
  const oldLineCount = splitLines(source.code).length;
  const nextLineCount = splitLines(nextCode).length;
  return {
    code: nextCode,
    lineMap: nextLineCount === oldLineCount
      ? source.lineMap
      : normalizeLineMap(nextCode, source.lineMap)
  };
}

function createMappedCodeBuilder() {
  const lines = [];
  const lineMap = [];
  return {
    addGenerated(value) {
      for (const line of Array.isArray(value) ? value : splitLines(String(value))) {
        lines.push(line);
        lineMap.push(null);
      }
    },
    addMapped(source, indent = '') {
      const sourceLines = splitLines(source.code);
      for (let index = 0; index < sourceLines.length; index += 1) {
        lines.push(`${indent}${sourceLines[index]}`);
        lineMap.push(source.lineMap[index] ?? null);
      }
    },
    build() {
      return {
        code: lines.join('\n'),
        lineMap
      };
    }
  };
}

function trimMappedSource(source) {
  const lines = splitLines(source.code);
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return {
    code: lines.slice(start, end).join('\n'),
    lineMap: source.lineMap.slice(start, end)
  };
}

function buildDefaultVaryingInitializers(varyings) {
  return varyings.map((varying) => `  ${varying.vertexName} = ${defaultWgslValue(varying.type)};`);
}

function stripGlslDirectives(source) {
  return String(source ?? '')
    .replace(/^\s*#version\s+\d+\s*$/gm, '')
    .replace(/^\s*#extension\s+.+$/gm, '');
}

function findBufferArrayMember(source, blockName) {
  const blockPattern = new RegExp(String.raw`buffer\s+[A-Za-z_][A-Za-z0-9_]*\s*\{([^{}]*)\}\s*${blockName}\s*;`);
  const blockMatch = blockPattern.exec(String(source));
  const memberMatch = /\b(?:float|uint)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*[^\]]*\s*\]\s*;/.exec(blockMatch?.[1] ?? '');
  return memberMatch?.[1] ?? null;
}

function blankPreservingLineCount(match) {
  return '\n'.repeat(countNewlines(match));
}

function countNewlines(value) {
  return (String(value).match(/\n/g) ?? []).length;
}

function splitLines(value) {
  return String(value ?? '').split('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
