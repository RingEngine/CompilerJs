import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FilterCompilerError,
  compileFilterSourceFiles,
  compileFilterSourceFilesWithDiagnostics
} from '../../src/index.js';
import { createNodeShaderCompiler } from '../../src/glslang-node.js';
import { compileFilterSourceDirectoryWithDiagnostics } from '../../src/node.js';
import { createComputeProject, createRenderProject } from './_shared.js';

test('compileFilterSourceFiles surfaces shader compiler failures as shader_compile_error', async () => {
  const project = createRenderProject();
  const compiler = {
    async compileGLSL() {
      throw new Error('backend compiler exploded');
    }
  };

  await assert.rejects(
    () => compileFilterSourceFiles(project, { compiler }),
    (error) => {
      assert.ok(error instanceof FilterCompilerError);
      assert.ok(error.diagnostics.some((item) =>
        item.severity === 'error' && item.code === 'shader_compile_error'
      ));
      assert.doesNotMatch(error.diagnostics[0].message, /Source excerpt:/);
      return true;
    }
  );
});

test('compileFilterSourceFiles includes backend shader error logs and source location', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      'layout(location = 0) out vec4 outColor;',
      'void main() {',
      '  vec4 output = vec4(1.0);',
      '  outColor = output;',
      '}',
      ''
    ].join('\n')
  });
  const compiler = await createNodeShaderCompiler();

  await assert.rejects(
    () => compileFilterSourceFiles(project, { compiler }),
    (error) => {
      assert.ok(error instanceof FilterCompilerError);
      const diagnostic = error.diagnostics.find((item) => item.code === 'shader_compile_error');
      assert.equal(diagnostic.severity, 'error');
      assert.equal(diagnostic.path, 'shaders/tone.frag.glsl');
      assert.equal(diagnostic.line, 4);
      assert.match(diagnostic.message, /'output'\s*:\s*Reserved word/);
      assert.doesNotMatch(diagnostic.message, /Source excerpt:/);
      return true;
    }
  );
});

test('compileFilterSourceFilesWithDiagnostics returns reflection-backed Lua warnings', async () => {
  const project = createRenderProject({
    mainLua: [
      'function onReset(ctx)',
      'end',
      '',
      'function advance(ctx)',
      '  ctx:runRenderPass("tone", {',
      '    source = ctx:getInput(),',
      '    params = { color = { 1.0, 0.0, 0.0, 1.0 } }',
      '  }, ctx:getOutput())',
      'end',
      ''
    ].join('\n'),
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 0, binding = 0) uniform sampler2D source;',
      'layout(set = 0, binding = 1) uniform OverlayParams {',
      '  vec4 color;',
      '  vec4 color2;',
      '} params;',
      '',
      'void main() {',
      '  outColor = params.color;',
      '}',
      ''
    ].join('\n')
  });
  const compiler = await createNodeShaderCompiler();

  const result = await compileFilterSourceFilesWithDiagnostics(project, { compiler });

  assert.equal(result.ok, true);
  assert.ok(result.files['manifest.json']);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'warning'
      && item.code === 'missing_uniform_block_field'
      && item.message.includes('color2')
  ));
});

test('compileFilterSourceFiles remains a virtual file map shortcut', async () => {
  const project = createRenderProject();
  const compiler = await createNodeShaderCompiler();

  const files = await compileFilterSourceFiles(project, { compiler });

  assert.equal(typeof files['manifest.json'], 'string');
  assert.ok(files['shaders/fullscreen.vert.spv'] instanceof Uint8Array);
});

test('web-preview backend emits WGSL with line maps without SPIR-V', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '#extension GL_GOOGLE_include_directive : require',
      '#include "shared/color.glsl"',
      '',
      'layout(set = 0, binding = 0) uniform sampler2D source;',
      'layout(location = 0) out vec4 outColor;',
      '',
      'void main() {',
      '  outColor = sharedColor() + texture(source, vec2(1.0));',
      '}',
      ''
    ].join('\n')
  });
  project['shaders/shared/color.glsl'] = [
    'vec4 sharedColor() {',
    '  return vec4(1.0);',
    '}',
    ''
  ].join('\n');

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });

  assert.equal(result.ok, true);
  assert.equal(typeof result.files['shaders/tone.wgsl'], 'string');
  assert.equal(result.files['shaders/tone.frag.spv'], undefined);
  assert.equal(result.files['shaders/tone.frag.glsl'], undefined);
  assert.match(result.files['shaders/tone.wgsl'], /fn sharedColor\(\) -> vec4<f32>/);
  assert.match(result.files['shaders/tone.wgsl'], /fn sampleImage_source\(uv: vec2<f32>\) -> vec4<f32>/);
  assert.match(result.files['shaders/tone.wgsl'], /clamp\(1\.0 - uv\.y, 0\.0, 1\.0\)/);
  assert.match(result.files['shaders/tone.wgsl'], /let pos = positions\[vertexIndex\];/);
  assert.doesNotMatch(result.files['shaders/tone.wgsl'], /#extension|#version/);

  const lineMap = JSON.parse(result.files['shaders/tone.wgsl.map.json']);
  assert.ok(lineMap.some((entry) =>
    entry?.path === 'shaders/shared/color.glsl' && entry.line === 1
  ));

  const manifest = JSON.parse(result.files['manifest.json']);
  assert.equal(manifest.passes[0].stages.vertex, 'shaders/tone.wgsl');
  assert.equal(manifest.passes[0].stages.fragment, 'shaders/tone.wgsl');
  assert.ok(Array.isArray(manifest.passes[0].bindings));
});

test('web-preview backend computes uniform block field offsets', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 0, binding = 0) uniform OverlayParams {',
      '  vec4 color;',
      '  vec4 color2;',
      '} params;',
      '',
      'void main() {',
      '  outColor = params.color;',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });
  const manifest = JSON.parse(result.files['manifest.json']);
  const params = manifest.passes[0].bindings.find((binding) => binding.name === 'params');

  assert.deepEqual(params.fields, [
    { name: 'color', type: 'vec4', offset: 0, size: 16 },
    { name: 'color2', type: 'vec4', offset: 16, size: 16 }
  ]);
});

test('node directory compiler forwards web-preview backend', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ring-compiler-web-preview-'));
  try {
    const project = createRenderProject();
    await Promise.all(Object.entries(project).map(async ([filePath, content]) => {
      const absolutePath = path.join(root, filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content);
    }));

    const result = await compileFilterSourceDirectoryWithDiagnostics(root, {
      backend: 'web-preview'
    });

    assert.equal(typeof result.files['shaders/tone.wgsl'], 'string');
    assert.equal(result.files['shaders/fullscreen.vert.spv'], undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('web-preview backend emits std140-compatible WGSL uniform block layout', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 0, binding = 0) uniform OverlayParams {',
      '  bool enabled;',
      '  float strength;',
      '  int mode;',
      '  uint count;',
      '  vec2 uv;',
      '  vec3 color;',
      '  vec4 color2;',
      '  ivec2 ij;',
      '  ivec3 ijk;',
      '  ivec4 ijkl;',
      '  uvec2 uij;',
      '  uvec3 uijk;',
      '  uvec4 uijkl;',
      '  mat2 m2;',
      '  mat3 m3;',
      '  mat4 m4;',
      '} params;',
      '',
      'float enabledValue() {',
      '  if (params.enabled) {',
      '    return 1.0;',
      '  }',
      '  return 0.0;',
      '}',
      '',
      'void main() {',
      '  outColor = vec4(enabledValue());',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });

  const wgsl = result.files['shaders/tone.wgsl'];
  assert.match(wgsl, /enabled: u32,/);
  assert.match(wgsl, /strength: f32,/);
  assert.match(wgsl, /mode: i32,/);
  assert.match(wgsl, /count: u32,/);
  assert.match(wgsl, /uv: vec2<f32>,/);
  assert.match(wgsl, /@size\(16\) color: vec3<f32>,/);
  assert.match(wgsl, /color2: vec4<f32>,/);
  assert.match(wgsl, /ij: vec2<i32>,/);
  assert.match(wgsl, /@size\(16\) ijk: vec3<i32>,/);
  assert.match(wgsl, /ijkl: vec4<i32>,/);
  assert.match(wgsl, /uij: vec2<u32>,/);
  assert.match(wgsl, /@size\(16\) uijk: vec3<u32>,/);
  assert.match(wgsl, /uijkl: vec4<u32>,/);
  assert.match(wgsl, /@align\(16\) @size\(32\) m2: mat2x2<f32>,/);
  assert.match(wgsl, /m3: mat3x3<f32>,/);
  assert.match(wgsl, /m4: mat4x4<f32>,/);
  assert.match(wgsl, /if \(\(params\.enabled != 0u\)\)/);
});

test('web-preview backend emits WGSL storage buffer declarations', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) buffer HistogramBuffer {',
      '  uint bins[];',
      '} histogram;',
      '',
      'void main() {',
      '  histogram.bins[0] = 1u;',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });

  assert.equal(typeof result.files['shaders/histogram.comp.wgsl'], 'string');
  assert.equal(result.files['shaders/histogram.comp.glsl'], undefined);
  assert.match(result.files['shaders/histogram.comp.wgsl'], /var<storage, read_write> histogram: array<atomic<u32>>;/);
  assert.match(result.files['shaders/histogram.comp.wgsl'], /atomicStore\(&histogram\[0\], 1u\);/);
  assert.doesNotMatch(result.files['shaders/histogram.comp.wgsl'], /histogram\.bins/);
});

test('web-preview backend lowers compute texelFetch with y-up coordinates', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) uniform sampler2D source;',
      '',
      'void main() {',
      '  ivec2 pixel = ivec2(gl_GlobalInvocationID.xy);',
      '  vec3 rgb = texelFetch(source, pixel, 0).rgb;',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });

  const wgsl = result.files['shaders/histogram.comp.wgsl'];
  assert.match(wgsl, /fn loadTexel_source\(coord: vec2<i32>\) -> vec4<f32>/);
  assert.match(wgsl, /let y = clamp\(height - 1 - coord\.y, 0, height - 1\);/);
  assert.match(wgsl, /var rgb: vec3<f32> = loadTexel_source\(pixel\)\.rgb;/);
});

test('web-preview backend lowers fixed-size storage buffer member access', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 1, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) buffer HistogramBuffer {',
      '  uint bins[256];',
      '} histogram;',
      '',
      'void main() {',
      '  uint index = gl_GlobalInvocationID.x;',
      '  atomicAdd(histogram.bins[index], 1u);',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });

  const wgsl = result.files['shaders/histogram.comp.wgsl'];
  assert.match(wgsl, /atomicAdd\(&histogram\[index\], 1u\);/);
  assert.doesNotMatch(wgsl, /histogram\.bins/);
});

test('web-preview backend lowers multiple fixed-size storage buffer block names independently', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 1, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) readonly buffer HistogramBuffer {',
      '  uint bins[256];',
      '} histogram;',
      'layout(set = 0, binding = 1) buffer CdfBuffer {',
      '  float values[256];',
      '} cdf;',
      '',
      'void main() {',
      '  uint index = gl_GlobalInvocationID.x;',
      '  cdf.values[index] = float(histogram.bins[index]);',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview'
  });

  const wgsl = result.files['shaders/histogram.comp.wgsl'];
  assert.match(wgsl, /cdf\[index\] = f32\(histogram\[index\]\);/);
  assert.doesNotMatch(wgsl, /histogram\.bins|cdf\.values/);
});

test('compiler rejects incompatible explicit block layout standards', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(std430, set = 0, binding = 0) uniform OverlayParams {',
      '  vec4 color;',
      '} params;',
      '',
      'void main() {',
      '  outColor = params.color;',
      '}',
      ''
    ].join('\n')
  });

  await assert.rejects(
    () => compileFilterSourceFilesWithDiagnostics(project, { backend: 'web-preview' }),
    (error) => {
      assert.ok(error instanceof FilterCompilerError);
      const diagnostic = error.diagnostics.find((item) => item.code === 'invalid_block_layout_standard');
      assert.equal(diagnostic.severity, 'error');
      assert.equal(diagnostic.path, 'shaders/tone.frag.glsl');
      assert.equal(diagnostic.line, 5);
      assert.match(diagnostic.message, /std140/);
      return true;
    }
  );
});
