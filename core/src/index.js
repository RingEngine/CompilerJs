import { FILTER_SCHEMA_URL } from './schema-urls.js';
import { validateCompiledManifestAgainstSchema } from './compiled-manifest-schema.js';
import { COMPILER_RUNTIME_VERSION } from './compiler-config.js';
import { parseGlslSourceInterface } from './glsl-binding-layout.js';
import { lintLuaScript } from './lua-lint.js';
import { parseManifestWithPointers, validateManifestAgainstSchema } from './manifest-schema.js';

const FILTER_SRC_REQUIRED_FILES = ['manifest.json', 'main.lua'];
const COMPILED_BINDING_TYPES = new Set(['sampledImage', 'buffer', 'uniformBlock', 'uniform']);
const BUFFER_ELEMENT_TYPES = new Set(['float', 'uint']);
const UNIFORM_FIELD_TYPES = new Set([
  'float',
  'bool',
  'int',
  'uint',
  'vec2',
  'vec3',
  'vec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'mat2',
  'mat3',
  'mat4'
]);
const DECLARED_UNIFORM_FIELD_TYPES = new Set([
  ...UNIFORM_FIELD_TYPES
]);

/**
 * @typedef {{ path: string, text?: string, bytes?: Uint8Array, mediaType?: string }} MemoryFile
 * @typedef {{ severity: 'error'|'warning', code: string, message: string, path?: string, line?: number, column?: number }} Diagnostic
 * @typedef {Record<string, string|Uint8Array>} VirtualFileMap
 * @typedef {'spirv'|'web-preview'} CompilerBackend
 * @typedef {{ ok: boolean, files: VirtualFileMap, diagnostics: Diagnostic[] }} CompileResult
 * @typedef {{ compileGLSL(source: string, stage: 'vertex'|'fragment'|'compute', options?: { debug?: boolean, spirvVersion?: '1.0'|'1.1'|'1.2'|'1.3'|'1.4'|'1.5' }): Promise<Uint32Array>|Uint32Array }} ShaderCompiler
 */

export class FilterCompilerError extends Error {
  /**
   * @param {string} message
   * @param {Diagnostic[]} diagnostics
   */
  constructor(message, diagnostics) {
    super(message);
    this.name = 'FilterCompilerError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Normalize assorted in-memory file inputs into a virtual file map.
 *
 * @param {Record<string, string|Uint8Array|MemoryFile>|MemoryFile[]} input
 * @returns {VirtualFileMap}
 */
export function normalizeMemoryFiles(input) {
  const files = new Map();

  if (Array.isArray(input)) {
    for (const file of input) {
      addNormalizedFile(files, file.path, file);
    }
    return memoryFileMapToVirtualFileMap(files);
  }

  for (const [rawPath, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      addNormalizedFile(files, rawPath, { path: rawPath, text: value });
      continue;
    }

    if (value instanceof Uint8Array) {
      addNormalizedFile(files, rawPath, { path: rawPath, bytes: value });
      continue;
    }

    addNormalizedFile(files, rawPath, { path: rawPath, ...value });
  }

  return memoryFileMapToVirtualFileMap(files);
}

/**
 * Compile a virtual `filter-src` file map into a virtual output file map.
 *
 * @param {Record<string, string|Uint8Array|MemoryFile>|MemoryFile[]} input
 * @param {{ sourceName?: string, backend?: CompilerBackend, compiler?: ShaderCompiler, spirvVersion?: '1.0'|'1.1'|'1.2'|'1.3'|'1.4'|'1.5' }} options
 * @returns {Promise<VirtualFileMap>}
 */
export async function compileFilterSourceFiles(input, options) {
  const result = await compileFilterSourceFilesWithDiagnostics(input, options);
  return result.files;
}

/**
 * Compile a virtual `filter-src` file map and return produced files plus
 * warnings discovered during the full compile/reflection pipeline.
 *
 * @param {Record<string, string|Uint8Array|MemoryFile>|MemoryFile[]} input
 * @param {{ sourceName?: string, backend?: CompilerBackend, compiler?: ShaderCompiler, spirvVersion?: '1.0'|'1.1'|'1.2'|'1.3'|'1.4'|'1.5' }} options
 * @returns {Promise<CompileResult>}
 */
export async function compileFilterSourceFilesWithDiagnostics(input, options) {
  const backend = options?.backend ?? 'spirv';
  if (backend !== 'spirv' && backend !== 'web-preview') {
    throw new Error(`Unsupported compiler backend: ${backend}`);
  }
  if (backend === 'spirv' && (!options || !options.compiler)) {
    throw new Error('compileFilterSourceFiles requires options.compiler for the spirv backend.');
  }

  const sourceName = options.sourceName ?? 'filter-src';
  const sourceFiles = normalizeMemoryFiles(input);
  const diagnostics = [];

  for (const requiredPath of FILTER_SRC_REQUIRED_FILES) {
    if (!(requiredPath in sourceFiles)) {
      diagnostics.push(errorDiagnostic(
        'missing_required_file',
        `Missing required root file: ${requiredPath}`,
        requiredPath
      ));
    }
  }

  if (diagnostics.length > 0) {
    throw new FilterCompilerError('Required files are missing.', diagnostics);
  }

  const manifestText = getRequiredTextFile(sourceFiles, 'manifest.json', diagnostics);
  const mainLuaText = getRequiredTextFile(sourceFiles, 'main.lua', diagnostics);
  const manifestRecord = parseManifest(manifestText, diagnostics, 'manifest.json');
  if (manifestRecord) {
    await validateManifest(manifestRecord, sourceFiles, diagnostics);
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    throw new FilterCompilerError('Source project validation failed.', diagnostics);
  }

  const normalizedManifest = normalizeSourceManifest(manifestRecord.manifest);
  let compiledResult;
  try {
    compiledResult = await buildCompiledFileMap(
      normalizedManifest,
      mainLuaText,
      sourceFiles,
      sourceName,
      backend,
      options.compiler,
      options.spirvVersion ?? '1.0'
    );
  } catch (error) {
    if (error instanceof FilterCompilerError) {
      throw new FilterCompilerError(error.message, [
        ...diagnostics,
        ...error.diagnostics
      ]);
    }
    throw error;
  }

  diagnostics.push(...compiledResult.diagnostics);

  if (diagnostics.some((item) => item.severity === 'error')) {
    throw new FilterCompilerError('Source project validation failed.', diagnostics);
  }

  return {
    ok: true,
    files: compiledResult.files,
    diagnostics
  };
}

/**
 * Validate a `filter-src` virtual file map without producing compiled output.
 *
 * @param {Record<string, string|Uint8Array|MemoryFile>|MemoryFile[]} input
 * @returns {Promise<{ ok: boolean, diagnostics: Diagnostic[] }>}
 */
export async function validateFilterSource(input) {
  const sourceFiles = normalizeMemoryFiles(input);
  const diagnostics = [];

  for (const requiredPath of FILTER_SRC_REQUIRED_FILES) {
    if (!(requiredPath in sourceFiles)) {
      diagnostics.push(errorDiagnostic(
        'missing_required_file',
        `Missing required root file: ${requiredPath}`,
        requiredPath
      ));
    }
  }

  if (diagnostics.length === 0) {
    const manifestText = getRequiredTextFile(sourceFiles, 'manifest.json', diagnostics);
    const mainLuaText = getRequiredTextFile(sourceFiles, 'main.lua', diagnostics);
    const manifestRecord = parseManifest(manifestText, diagnostics, 'manifest.json');
    if (manifestRecord) {
      await validateManifest(manifestRecord, sourceFiles, diagnostics);
    }

    if (manifestRecord && !diagnostics.some((item) => item.severity === 'error')) {
      const normalizedManifest = normalizeSourceManifest(manifestRecord.manifest);
      diagnostics.push(...lintLuaScript(mainLuaText, {
        outputSizeMode: normalizedManifest.outputSizeMode,
        parameters: normalizedManifest.parameters,
        assets: normalizedManifest.assets,
        passes: normalizedManifest.passes
      }));
    }
  }

  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics
  };
}

/**
 * @deprecated Use compileFilterSourceFiles for the real core boundary.
 * @param {Record<string, string|Uint8Array|MemoryFile>|MemoryFile[]} input
 * @param {{ sourceName?: string, backend?: CompilerBackend, compiler?: ShaderCompiler, spirvVersion?: '1.0'|'1.1'|'1.2'|'1.3'|'1.4'|'1.5' }} options
 */
export async function compileFilterSource(input, options) {
  const { files, diagnostics } = await compileFilterSourceFilesWithDiagnostics(input, options);
  return {
    files,
    diagnostics,
    manifest: JSON.parse(String(files['manifest.json'])),
    summary: {
      outputFileCount: Object.keys(files).length
    }
  };
}

function addNormalizedFile(files, rawPath, file) {
  const normalizedPath = normalizeRelativePath(rawPath);
  if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/')) {
    throw new Error(`Absolute paths are not allowed: ${rawPath}`);
  }

  files.set(normalizedPath, {
    path: normalizedPath,
    text: file.text,
    bytes: file.bytes,
    mediaType: file.mediaType
  });
}

function getRequiredTextFile(files, filePath, diagnostics) {
  const fileValue = files[filePath];
  if (fileValue === undefined) {
    diagnostics.push(errorDiagnostic('missing_file', `Missing file: ${filePath}`, filePath));
    return '';
  }

  if (typeof fileValue !== 'string') {
    diagnostics.push(errorDiagnostic('invalid_text_file', `File must be text: ${filePath}`, filePath));
    return '';
  }

  return fileValue;
}

function parseManifest(manifestText, diagnostics, filePath) {
  try {
    return parseManifestWithPointers(manifestText);
  } catch (error) {
    const location = findOffsetLocation(manifestText, extractJsonErrorOffset(error));
    diagnostics.push({
      severity: 'error',
      code: 'invalid_manifest_json',
      message: `${filePath} is not valid JSON: ${error.message}`,
      path: filePath,
      line: location?.line,
      column: location?.column
    });
    return null;
  }
}

async function validateManifest(manifestRecord, sourceFiles, diagnostics) {
  if (!manifestRecord?.manifest || typeof manifestRecord.manifest !== 'object' || Array.isArray(manifestRecord.manifest)) {
    diagnostics.push(errorDiagnostic('invalid_manifest_root', 'manifest.json root must be an object.', 'manifest.json'));
    return;
  }

  const manifest = manifestRecord.manifest;
  const manifestPointers = manifestRecord.pointers;

  diagnostics.push(...await validateManifestAgainstSchema(manifest, manifestPointers));
  if (diagnostics.some((item) => item.severity === 'error')) return;

  validateManifestRuntimeVersion(manifest, diagnostics);
  if (diagnostics.some((item) => item.severity === 'error')) return;

  validateManifestSemanticConstraints(manifest, sourceFiles, diagnostics);
  validateShaderInterfaces(manifest.passes, sourceFiles, diagnostics);
}

export function validateManifestRuntimeVersion(manifest, diagnostics) {
  if (!Number.isInteger(manifest.runtimeVersion)) return;

  if (manifest.runtimeVersion > COMPILER_RUNTIME_VERSION) {
    diagnostics.push(errorDiagnostic(
      'unsupported_runtime_version',
      `manifest runtimeVersion ${manifest.runtimeVersion} is newer than the compiler runtimeVersion ${COMPILER_RUNTIME_VERSION}.`,
      'manifest.json#runtimeVersion'
    ));
    return;
  }

  if (manifest.runtimeVersion < COMPILER_RUNTIME_VERSION) {
    diagnostics.push(warningDiagnostic(
      'older_runtime_version',
      `manifest runtimeVersion ${manifest.runtimeVersion} is older than the compiler runtimeVersion ${COMPILER_RUNTIME_VERSION}. The compiled filter will preserve the source runtimeVersion.`,
      'manifest.json#runtimeVersion'
    ));
  }
}

function validateManifestSemanticConstraints(manifest, sourceFiles, diagnostics) {
  validateUniqueIds(manifest.parameters, 'parameter', diagnostics);
  validateUniqueIds(manifest.passes, 'pass', diagnostics);
  validateUniqueIds(manifest.assets, 'asset', diagnostics);
  validatePassShaderFiles(manifest.passes, sourceFiles, diagnostics);
  validateAssetFiles(manifest.assets, sourceFiles, diagnostics);
}

function validateUniqueIds(items, kind, diagnostics) {
  if (!Array.isArray(items)) return;

  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue;
    if (ids.has(item.id)) {
      diagnostics.push(errorDiagnostic(
        `duplicate_${kind}_id`,
        `Duplicate ${kind} id: ${item.id}`,
        `manifest.json#${kind}s[${index}]`
      ));
      continue;
    }
    ids.add(item.id);
  }
}

function validatePassShaderFiles(passes, sourceFiles, diagnostics) {
  if (!Array.isArray(passes)) return;

  for (const [index, pass] of passes.entries()) {
    if (!isPlainObject(pass) || typeof pass.type !== 'string') continue;

    const location = `manifest.json#passes[${index}]`;
    if (pass.type === 'render') {
      validateReferencedTextFile(pass.vertexShader, 'vertexShader', sourceFiles, diagnostics, location, 'shader');
      validateReferencedTextFile(pass.fragmentShader, 'fragmentShader', sourceFiles, diagnostics, location, 'shader');
    }

    if (pass.type === 'compute') {
      validateReferencedTextFile(pass.computeShader, 'computeShader', sourceFiles, diagnostics, location, 'shader');
    }
  }
}

function validateAssetFiles(assets, sourceFiles, diagnostics) {
  if (!Array.isArray(assets)) return;

  for (const [index, asset] of assets.entries()) {
    if (!isPlainObject(asset) || typeof asset.path !== 'string') continue;
    validateReferencedFile(asset.path, sourceFiles, diagnostics, `manifest.json#assets[${index}]`, 'asset');
  }
}

function validateReferencedTextFile(filePath, field, sourceFiles, diagnostics, location, kind) {
  const normalizedPath = validateReferencedFile(filePath, sourceFiles, diagnostics, location, kind);
  if (!normalizedPath) return;

  const file = sourceFiles[normalizedPath];
  if (typeof file !== 'string') {
    diagnostics.push(errorDiagnostic(
      `invalid_${kind}_file`,
      `${field} must reference a text file: ${filePath}`,
      location
    ));
  }
}

function validateReferencedFile(filePath, sourceFiles, diagnostics, location, kind) {
  if (typeof filePath !== 'string') return '';

  const normalizedPath = normalizeRelativePath(filePath);
  if (!(normalizedPath in sourceFiles)) {
    diagnostics.push(errorDiagnostic(`missing_${kind}_file`, `Missing ${kind} file: ${filePath}`, location));
    return '';
  }

  return normalizedPath;
}

function validateShaderInterfaces(passes, sourceFiles, diagnostics) {
  if (!Array.isArray(passes)) return;

  for (const [index, pass] of passes.entries()) {
    if (!isPlainObject(pass) || (pass.type !== 'render' && pass.type !== 'compute')) continue;

    const shaderEntries = pass.type === 'render'
      ? [
          ['vertexShader', pass.vertexShader],
          ['fragmentShader', pass.fragmentShader]
        ]
      : [['computeShader', pass.computeShader]];

    for (const [field, shaderPath] of shaderEntries) {
      if (typeof shaderPath !== 'string') continue;
      const normalizedPath = normalizeRelativePath(shaderPath);
      let preprocessed;
      try {
        preprocessed = preprocessShaderSource(normalizedPath, sourceFiles);
      } catch (error) {
        if (error instanceof FilterCompilerError) {
          diagnostics.push(...error.diagnostics);
          continue;
        }
        throw error;
      }

      const parsed = parseGlslSourceInterface(preprocessed.source);
      diagnostics.push(...mapPreprocessDiagnostics(preprocessed.diagnostics, preprocessed.sourceMap, normalizedPath));
      for (const item of parsed.diagnostics) {
        const sourceLocation = item.line ? preprocessed.sourceMap?.[item.line - 1] : null;
        diagnostics.push({
          severity: 'error',
          code: item.code,
          message: `${item.message} (${field} in pass "${pass.id ?? index}")`,
          path: sourceLocation?.path ?? normalizedPath,
          line: sourceLocation?.line ?? item.line,
          column: item.column
        });
      }

      if (field === 'vertexShader') {
        validateRenderVertexInputShape(parsed.vertexInputs, normalizedPath, diagnostics);
      }

      validateDeclaredShaderBindings(parsed.bindings, diagnostics, normalizedPath, pass.id ?? index);
    }
  }
}

function validateRenderVertexInputShape(vertexInputs, shaderPath, diagnostics) {
  if (vertexInputs.length === 1 && vertexInputs[0]?.typeName === 'vec2') {
    return;
  }

  diagnostics.push(warningDiagnostic(
    'unexpected_render_vertex_input_shape',
    'Render vertex shaders should declare exactly one `in vec2` vertex input.',
    shaderPath
  ));
}

function validateDeclaredShaderBindings(bindings, diagnostics, shaderPath, passId) {
  for (const binding of bindings) {
    if (!COMPILED_BINDING_TYPES.has(binding.type)) {
      diagnostics.push(errorDiagnostic(
        'unsupported_binding_type',
        `Unsupported binding type "${binding.type}" for "${binding.name}" in pass "${passId}".`,
        shaderPath
      ));
      continue;
    }

    if (binding.type === 'buffer' && !BUFFER_ELEMENT_TYPES.has(binding.elementType)) {
      diagnostics.push(errorDiagnostic(
        'unsupported_buffer_element_type',
        `Buffer "${binding.name}" uses unsupported element type "${binding.elementType}". Supported buffer element types are float and uint.`,
        shaderPath
      ));
    }

    if (binding.type === 'uniformBlock') {
      for (const field of binding.fields ?? []) {
        if (!DECLARED_UNIFORM_FIELD_TYPES.has(field.type)) {
          diagnostics.push(errorDiagnostic(
            'unsupported_uniform_field_type',
            `Uniform block "${binding.name}" field "${field.name}" uses unsupported type "${field.type}".`,
            shaderPath
          ));
        }
      }
    }
  }
}

function normalizeSourceManifest(manifest) {
  return {
    $schema: manifest.$schema,
    schemaVersion: manifest.schemaVersion,
    runtimeVersion: manifest.runtimeVersion,
    outputSizeMode: manifest.outputSizeMode ?? 'passive',
    metadata: manifest.metadata ?? {},
    parameters: manifest.parameters ?? [],
    passes: manifest.passes ?? [],
    assets: manifest.assets ?? []
  };
}

async function buildCompiledFileMap(manifest, mainLuaText, sourceFiles, sourceName, backend, compiler, spirvVersion) {
  const files = {};
  const diagnostics = [];
  const shaderArtifacts = new Map();
  const compiledManifest = {
    $schema: FILTER_SCHEMA_URL,
    kind: 'filter',
    formatVersion: '0.2.0',
    sourceName,
    sourceSchemaVersion: manifest.schemaVersion,
    runtimeVersion: manifest.runtimeVersion,
    outputSizeMode: manifest.outputSizeMode,
    metadata: manifest.metadata,
    parameters: manifest.parameters,
    mainScript: 'main.lua',
    passes: [],
    assets: manifest.assets.map((asset) => buildCompiledAssetManifest(asset))
  };

  files['main.lua'] = mainLuaText;

  for (const pass of manifest.passes) {
    const compiledPass = await compilePass(pass, sourceFiles, backend, compiler, spirvVersion, shaderArtifacts);
    compiledManifest.passes.push(compiledPass.manifest);
    Object.assign(files, compiledPass.files);
  }

  const luaDiagnostics = lintLuaScript(mainLuaText, {
    outputSizeMode: manifest.outputSizeMode,
    parameters: manifest.parameters,
    assets: manifest.assets,
    passes: compiledManifest.passes
  });
  diagnostics.push(...luaDiagnostics);

  for (const asset of manifest.assets) {
    const sourceFile = sourceFiles[normalizeRelativePath(asset.path)];
    files[buildAssetOutputPath(asset)] = cloneVirtualFileValue(sourceFile);
  }

  if (backend === 'spirv') {
    const compiledManifestDiagnostics = await validateCompiledManifestAgainstSchema(compiledManifest);
    diagnostics.push(...compiledManifestDiagnostics);
  }

  files['manifest.json'] = JSON.stringify(compiledManifest, null, 2);
  return {
    files,
    diagnostics
  };
}

async function compilePass(pass, sourceFiles, backend, compiler, spirvVersion, shaderArtifacts) {
  if (pass.type === 'render') {
    const vertexArtifact = await getOrBuildShaderArtifact(
      normalizeRelativePath(pass.vertexShader),
      sourceFiles,
      backend,
      compiler,
      'vertex',
      spirvVersion,
      shaderArtifacts
    );
    const fragmentArtifact = await getOrBuildShaderArtifact(
      normalizeRelativePath(pass.fragmentShader),
      sourceFiles,
      backend,
      compiler,
      'fragment',
      spirvVersion,
      shaderArtifacts
    );

    return {
      manifest: {
        id: pass.id,
        type: pass.type,
        stages: {
          vertex: vertexArtifact.outputPath,
          fragment: fragmentArtifact.outputPath
        },
        vertexInput: vertexArtifact.reflection.entryPoint.inputVariables,
        bindings: mergeBindingReflection(
          vertexArtifact.reflection.entryPoint.bindings,
          fragmentArtifact.reflection.entryPoint.bindings
        )
      },
      files: buildShaderFilesMap([vertexArtifact, fragmentArtifact])
    };
  }

  const computeArtifact = await getOrBuildShaderArtifact(
    normalizeRelativePath(pass.computeShader),
    sourceFiles,
    backend,
    compiler,
    'compute',
    spirvVersion,
    shaderArtifacts
  );

  return {
    manifest: {
      id: pass.id,
      type: pass.type,
      stages: {
        compute: computeArtifact.outputPath
      },
      localSize: computeArtifact.reflection.entryPoint.localSize,
      bindings: computeArtifact.reflection.entryPoint.bindings
    },
    files: buildShaderFilesMap([computeArtifact])
  };
}

async function getOrBuildShaderArtifact(shaderPath, sourceFiles, backend, compiler, stage, spirvVersion, shaderArtifacts) {
  const cacheKey = `${backend}:${stage}:${shaderPath}`;
  const existing = shaderArtifacts.get(cacheKey);
  if (existing) {
    return existing;
  }

  const preprocessed = preprocessShaderSource(shaderPath, sourceFiles);
  if (preprocessed.diagnostics.some((item) => item.severity === 'error')) {
    throw new FilterCompilerError('Shader source preprocessing failed.', preprocessed.diagnostics);
  }

  const interfaceInfo = parseGlslSourceInterface(preprocessed.source);
  if (interfaceInfo.diagnostics.length > 0) {
    throw new FilterCompilerError('Shader source preprocessing failed.', mapPreprocessDiagnostics(
      interfaceInfo.diagnostics.map((item) => ({ severity: 'error', ...item })),
      preprocessed.sourceMap,
      shaderPath
    ));
  }

  const reflection = buildGlslReflection(interfaceInfo, stage, preprocessed.source);
  const artifact = backend === 'web-preview'
    ? buildWebPreviewShaderArtifact(shaderPath, preprocessed, stage, reflection)
    : await buildSpirvShaderArtifact(shaderPath, preprocessed, compiler, stage, spirvVersion, reflection);

  shaderArtifacts.set(cacheKey, artifact);
  return artifact;
}

async function buildSpirvShaderArtifact(shaderPath, preprocessed, compiler, stage, spirvVersion, reflection) {
  let spirv;
  try {
    spirv = await compileShaderSource(compiler, preprocessed.source, stage, spirvVersion);
  } catch (error) {
    throw new FilterCompilerError('Shader compilation failed.', [
      buildShaderCompileDiagnostic(stage, shaderPath, preprocessed, error)
    ]);
  }

  return {
    stage,
    sourcePath: shaderPath,
    source: preprocessed.source,
    sourceMap: preprocessed.sourceMap,
    outputPath: buildShaderOutputPath(shaderPath),
    reflection,
    bytes: wordsToBytes(spirv)
  };
}

function buildWebPreviewShaderArtifact(shaderPath, preprocessed, stage, reflection) {
  return {
    stage,
    sourcePath: shaderPath,
    source: preprocessed.source,
    sourceMap: preprocessed.sourceMap,
    outputPath: buildWebPreviewShaderOutputPath(shaderPath),
    reflection,
    text: preprocessed.source,
    mapText: JSON.stringify(preprocessed.sourceMap, null, 2)
  };
}

function buildShaderFilesMap(artifacts) {
  const files = {};
  for (const artifact of artifacts) {
    files[artifact.outputPath] = artifact.bytes ?? artifact.text;
    if (artifact.mapText) {
      files[`${artifact.outputPath}.map.json`] = artifact.mapText;
    }
  }
  return files;
}

function buildShaderOutputPath(shaderPath) {
  return normalizeRelativePath(shaderPath).replace(/\.glsl$/i, '.spv');
}

function buildWebPreviewShaderOutputPath(shaderPath) {
  return normalizeRelativePath(shaderPath);
}

function preprocessShaderSource(shaderPath, sourceFiles, includeStack = []) {
  const normalizedPath = normalizeRelativePath(shaderPath);
  const source = sourceFiles[normalizedPath];
  if (typeof source !== 'string') {
    throw new FilterCompilerError('Shader source preprocessing failed.', [
      errorDiagnostic('missing_shader_file', `Missing shader file: ${normalizedPath}`, normalizedPath)
    ]);
  }
  if (includeStack.includes(normalizedPath)) {
    throw new FilterCompilerError('Shader source preprocessing failed.', [
      errorDiagnostic(
        'circular_shader_include',
        `Circular shader include: ${[...includeStack, normalizedPath].join(' -> ')}`,
        normalizedPath
      )
    ]);
  }

  const outputLines = [];
  const sourceMap = [];
  const diagnostics = [];
  const sourceLines = splitLines(source);
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    const includeMatch = /^\s*#include\s+[<"]([^>"]+)[>"]\s*$/.exec(line);
    if (includeMatch) {
      const includePath = resolveShaderIncludePath(normalizedPath, includeMatch[1]);
      const included = preprocessShaderSource(includePath, sourceFiles, [...includeStack, normalizedPath]);
      outputLines.push(...splitLines(included.source));
      sourceMap.push(...included.sourceMap);
      diagnostics.push(...included.diagnostics);
      continue;
    }

    outputLines.push(line);
    sourceMap.push({
      path: normalizedPath,
      line: index + 1
    });
  }

  const normalized = normalizeGlslBlockLayouts(outputLines.join('\n'), sourceMap, normalizedPath);
  return {
    ...normalized,
    diagnostics: [
      ...diagnostics,
      ...normalized.diagnostics
    ]
  };
}

const BLOCK_LAYOUT_STANDARDS = new Set(['std140', 'std430', 'shared', 'packed', 'scalar']);

function normalizeGlslBlockLayouts(source, sourceMap, fallbackPath) {
  const lines = splitLines(source);
  const diagnostics = [];
  const normalizedLines = lines.map((line, index) => {
    const blockMatch = /^(\s*)layout\s*\(([^)]*)\)(\s+(?:(?:readonly|writeonly)\s+)?)(uniform|buffer)(\s+[A-Za-z_][A-Za-z0-9_]*\s*\{.*)$/.exec(line);
    if (!blockMatch) {
      return line;
    }

    const storage = blockMatch[4];
    const requiredStandard = storage === 'uniform' ? 'std140' : 'std430';
    const layoutItems = blockMatch[2].split(',').map((item) => item.trim()).filter(Boolean);
    const explicitStandards = layoutItems.filter((item) => BLOCK_LAYOUT_STANDARDS.has(item));
    const sourceLocation = sourceMap[index] ?? { path: fallbackPath, line: index + 1 };

    if (explicitStandards.length > 0 && (explicitStandards.length !== 1 || explicitStandards[0] !== requiredStandard)) {
      diagnostics.push(errorDiagnostic(
        'invalid_block_layout_standard',
        `${storage === 'uniform' ? 'Uniform block' : 'Storage buffer'} layout must use ${requiredStandard}. Found ${explicitStandards.join(', ')}.`,
        sourceLocation.path,
        sourceLocation.line
      ));
      return line;
    }

    if (explicitStandards[0] === requiredStandard) {
      return line;
    }

    const normalizedLayout = [requiredStandard, ...layoutItems].join(', ');
    return `${blockMatch[1]}layout(${normalizedLayout})${blockMatch[3]}${storage}${blockMatch[5]}`;
  });

  return {
    source: normalizedLines.join('\n'),
    sourceMap,
    diagnostics
  };
}

function mapPreprocessDiagnostics(diagnostics, sourceMap, fallbackPath) {
  return diagnostics.map((item) => {
    const sourceLocation = item.line ? sourceMap?.[item.line - 1] : null;
    return {
      severity: item.severity ?? 'error',
      code: item.code,
      message: item.message,
      path: item.path ?? sourceLocation?.path ?? fallbackPath,
      line: item.path ? item.line : (sourceLocation?.line ?? item.line),
      column: item.column
    };
  });
}

function resolveShaderIncludePath(fromPath, includePath) {
  const normalizedIncludePath = normalizeRelativePath(includePath);
  if (includePath.startsWith('/')) return normalizeRelativePath(includePath.slice(1));
  const directory = normalizeRelativePath(fromPath).split('/').slice(0, -1).join('/');
  return normalizeRelativePath(directory ? `${directory}/${normalizedIncludePath}` : normalizedIncludePath);
}

function buildGlslReflection(interfaceInfo, stage, source) {
  return {
    entryPoint: {
      inputVariables: stage === 'vertex'
        ? interfaceInfo.vertexInputs.map((input) => ({
            name: input.name,
            location: input.location,
            type: input.typeName
          }))
        : [],
      bindings: interfaceInfo.bindings.map((binding) => normalizeGlslBindingForManifest(binding)),
      localSize: stage === 'compute' ? extractComputeLocalSize(source) : undefined
    }
  };
}

function normalizeGlslBindingForManifest(binding) {
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
    normalized.fields = layoutUniformBlockFields(binding.fields ?? []);
  }

  if (binding.type === 'uniform') {
    normalized.valueType = binding.valueType;
  }

  return normalized;
}

function layoutUniformBlockFields(fields) {
  let offset = 0;
  return fields.map((field) => {
    const layout = getUniformFieldLayout(field.type);
    const fieldOffset = alignTo(offset, layout.align);
    offset = fieldOffset + layout.size;
    return {
      ...field,
      offset: fieldOffset,
      size: layout.size
    };
  });
}

function getUniformFieldLayout(type) {
  switch (type) {
    case 'float':
    case 'bool':
    case 'int':
    case 'uint':
      return { align: 4, size: 4 };
    case 'vec2':
    case 'ivec2':
    case 'uvec2':
      return { align: 8, size: 8 };
    case 'vec3':
    case 'vec4':
    case 'ivec3':
    case 'ivec4':
    case 'uvec3':
    case 'uvec4':
      return { align: 16, size: 16 };
    case 'mat2':
      return { align: 16, size: 32 };
    case 'mat3':
      return { align: 16, size: 48 };
    case 'mat4':
      return { align: 16, size: 64 };
    default:
      return { align: 4, size: 4 };
  }
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function extractComputeLocalSize(source) {
  const layoutMatch = /layout\s*\(\s*([^)]*local_size_[^)]*)\)\s*in\s*;/m.exec(source);
  const layout = layoutMatch?.[1] ?? '';
  const readSize = (axis) => {
    const match = new RegExp(String.raw`local_size_${axis}\s*=\s*(\d+)`).exec(layout);
    return match ? Number.parseInt(match[1], 10) : 1;
  };
  return {
    x: readSize('x'),
    y: readSize('y'),
    z: readSize('z')
  };
}

function glslVectorComponentCount(typeName) {
  const match = /^(?:[iub]?vec)(\d)$/.exec(typeName ?? '');
  return match ? Number.parseInt(match[1], 10) : 1;
}

function splitLines(value) {
  return String(value ?? '').split('\n');
}

async function compileShaderSource(compiler, source, stage, spirvVersion) {
  const words = await compiler.compileGLSL(source, stage, {
    debug: true,
    spirvVersion
  });
  return words instanceof Uint32Array ? words : new Uint32Array(words);
}

function buildShaderCompileDiagnostic(stage, shaderPath, preprocessed, error) {
  const compilerLog = normalizeCompilerLog(error?.compilerLog);
  const detailMessages = extractShaderErrorMessages(compilerLog);
  const location = extractShaderErrorLocation(compilerLog || (error?.message ?? ''));
  const sourceLocation = location ? preprocessed.sourceMap?.[location.line - 1] : null;
  const detail = detailMessages.length > 0
    ? detailMessages.join('\n')
    : error?.message ?? 'Unknown shader compiler error.';
  const message = [
    `${stage} shader compilation failed for ${shaderPath}.`,
    detail
  ].filter(Boolean).join('\n');

  return {
    severity: 'error',
    code: 'shader_compile_error',
    message,
    path: sourceLocation?.path ?? shaderPath,
    line: sourceLocation?.line ?? location?.line,
    column: location?.column
  };
}

function normalizeCompilerLog(value) {
  return typeof value === 'string'
    ? value
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .join('\n')
    : '';
}

function extractShaderErrorMessages(log) {
  if (!log) return [];

  const messages = [];
  for (const line of log.split(/\r?\n/)) {
    if (/^Parse failed\b/i.test(line)) continue;
    if (/^ERROR:\s*\d+:\d+:\s*''\s*:\s*compilation terminated/i.test(line)) continue;
    if (/^ERROR:\s*\d+\s+compilation errors?\.\s+No code generated\./i.test(line)) continue;
    if (/^ERROR:/i.test(line)) {
      messages.push(line);
    }
  }

  return messages.length > 0 ? messages : [log];
}

function extractShaderErrorLocation(message) {
  const patterns = [
    /ERROR:\s*\d+:(\d+):(?:(\d+):)?/i,
    /(?:^|\D)(\d+):(\d+):\s*(?:error|ERROR)\b/,
    /\bline\s+(\d+)(?:[,:\s]+column\s+(\d+))?/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;

    const line = Number.parseInt(match[1], 10);
    const column = match[2] !== undefined ? Number.parseInt(match[2], 10) - 1 : undefined;
    if (Number.isInteger(line) && line > 0) {
      return { line, column: Number.isInteger(column) && column >= 0 ? column : undefined };
    }
  }

  return null;
}

function mergeBindingReflection(...bindingGroups) {
  const merged = new Map();

  for (const bindings of bindingGroups) {
    for (const binding of bindings) {
      const key = `${binding.set}:${binding.binding}`;
      const previous = merged.get(key);
      merged.set(key, previous ? mergeBindingRecord(previous, binding) : binding);
    }
  }

  return Array.from(merged.values());
}

function mergeBindingRecord(previous, next) {
  return {
    ...previous,
    ...next,
    fields: next.fields ?? previous.fields
  };
}

function mergeVertexInputReflection(reflectedInputs, declaredInputs) {
  const declaredByLocation = new Map();
  for (const declared of declaredInputs) {
    if (declared.location === undefined) continue;
    declaredByLocation.set(declared.location, declared);
  }

  return reflectedInputs.map((input) => {
    const declared = declaredByLocation.get(input.location);
    return {
      name: declared?.name ?? input.name,
      location: input.location,
      type: declared?.typeName ?? summarizeVertexInputType(input.type)
    };
  });
}

function summarizeVertexInputType(type) {
  if (type?.kind === 'vector' && type.componentType?.kind === 'float') {
    return `vec${type.componentCount}`;
  }

  return type?.kind ?? 'unknown';
}

function buildCompiledAssetManifest(asset) {
  return {
    id: asset.id,
    type: asset.type,
    path: buildAssetOutputPath(asset)
  };
}

function buildAssetOutputPath(asset) {
  const sourceExtension = getFileExtension(normalizeRelativePath(asset.path));
  return `assets/${asset.id}${sourceExtension || ''}`;
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function getFileExtension(filePath) {
  const normalized = normalizeRelativePath(filePath);
  const lastSlashIndex = normalized.lastIndexOf('/');
  const lastDotIndex = normalized.lastIndexOf('.');
  if (lastDotIndex <= lastSlashIndex) return '';
  return normalized.slice(lastDotIndex);
}

function requireString(object, key, diagnostics, location, pattern) {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    diagnostics.push(errorDiagnostic('missing_string_field', `${key} must be a non-empty string.`, location));
    return;
  }
  if (pattern && !pattern.test(value)) {
    diagnostics.push(errorDiagnostic('invalid_string_format', `${key} has invalid format.`, location));
  }
}

function requireInteger(object, key, diagnostics, location, minimum) {
  const value = object[key];
  if (!Number.isInteger(value)) {
    diagnostics.push(errorDiagnostic('missing_integer_field', `${key} must be an integer.`, location));
    return;
  }
  if (typeof minimum === 'number' && value < minimum) {
    diagnostics.push(errorDiagnostic('integer_too_small', `${key} must be >= ${minimum}.`, location));
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorDiagnostic(code, message, filePath, line, column) {
  return {
    severity: 'error',
    code,
    message,
    path: filePath,
    line,
    column
  };
}

function warningDiagnostic(code, message, filePath, line, column) {
  return {
    severity: 'warning',
    code,
    message,
    path: filePath,
    line,
    column
  };
}

function memoryFileMapToVirtualFileMap(files) {
  const result = {};
  for (const file of files.values()) {
    result[file.path] = file.text !== undefined
      ? file.text
      : new Uint8Array(file.bytes ?? new Uint8Array());
  }
  return result;
}

function cloneVirtualFileValue(value) {
  return typeof value === 'string' ? value : new Uint8Array(value);
}

function wordsToBytes(words) {
  return new Uint8Array(words.buffer.slice(
    words.byteOffset,
    words.byteOffset + words.byteLength
  ));
}

function extractJsonErrorOffset(error) {
  const match = /position (\d+)/i.exec(error?.message ?? '');
  return match ? Number.parseInt(match[1], 10) : null;
}

function findOffsetLocation(source, offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;

  let line = 1;
  let column = 0;
  const boundedOffset = Math.min(offset, source.length);

  for (let index = 0; index < boundedOffset; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      column = 0;
      continue;
    }

    column += 1;
  }

  return { line, column };
}
