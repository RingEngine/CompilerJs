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

async function compileWebPreview(project) {
  return await compileFilterSourceFilesWithDiagnostics(project, {
    backend: 'web-preview',
    compiler: await createNodeShaderCompiler()
  });
}

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

test('compileFilterSourceFiles preserves runtimeHints in compiled manifest', async () => {
  const project = createRenderProject({
    manifest: {
      runtimeHints: {
        frameInvalidation: 'continuous'
      }
    }
  });
  const compiler = await createNodeShaderCompiler();

  const files = await compileFilterSourceFiles(project, { compiler });
  const manifest = JSON.parse(String(files['manifest.json']));

  assert.deepEqual(manifest.runtimeHints, {
    frameInvalidation: 'continuous'
  });
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

  const result = await compileWebPreview(project);

  assert.equal(result.ok, true);
  assert.equal(typeof result.files['shaders/fullscreen.vert.wgsl'], 'string');
  assert.equal(typeof result.files['shaders/tone.frag.wgsl'], 'string');
  assert.equal(result.files['shaders/tone.frag.spv'], undefined);
  assert.equal(result.files['shaders/tone.frag.glsl'], undefined);
  assert.match(result.files['shaders/tone.frag.wgsl'], /fn sharedColor\(\) -> vec4<f32>/);
  assert.match(result.files['shaders/tone.frag.wgsl'], /textureSample\(source_texture, source_sampler,/);
  assert.doesNotMatch(result.files['shaders/tone.frag.wgsl'], /ringSampleImage_source|1\.0 - uv\.y/);
  assert.match(result.files['shaders/fullscreen.vert.wgsl'], /@vertex/);
  assert.match(result.files['shaders/fullscreen.vert.wgsl'], /\.gl_Position\.y\s*=\s*-\(/);
  assert.doesNotMatch(result.files['shaders/tone.frag.wgsl'], /#extension|#version/);

  const lineMap = JSON.parse(result.files['shaders/tone.frag.wgsl.map.json']);
  assert.ok(Array.isArray(lineMap));

  const manifest = JSON.parse(result.files['manifest.json']);
  assert.equal(manifest.passes[0].stages.vertex, 'shaders/fullscreen.vert.wgsl');
  assert.equal(manifest.passes[0].stages.fragment, 'shaders/tone.frag.wgsl');
  assert.ok(Array.isArray(manifest.passes[0].bindings));
  assert.equal(manifest.passes[0].bindings[0].samplerBinding, 1);
});

test('web-preview backend lowers GLSL const declarations, atan2 calls, and ternary assignments structurally', async () => {
  const project = createRenderProject({
    vertexShader: [
      '#version 450',
      '',
      'layout(location = 0) in vec2 a_position;',
      'layout(location = 0) out vec2 v_ndc;',
      '',
      'layout(set = 0, binding = 1) uniform RadialParams {',
      '  vec2 outputSize;',
      '  float activeSector;',
      '} params;',
      '',
      'void main() {',
      '  v_ndc = a_position * params.outputSize;',
      '  gl_Position = vec4(a_position, 0.0, 1.0);',
      '}',
      ''
    ].join('\n'),
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) in vec2 v_ndc;',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 0, binding = 0) uniform sampler2D source;',
      'layout(set = 0, binding = 1) uniform RadialParams {',
      '  vec2 outputSize;',
      '  float activeSector;',
      '} params;',
      '',
      'const float TWO_PI = 6.28318530717958647692;',
      'const float SECTOR_COUNT = 12.0;',
      '',
      'void main() {',
      '  vec2 centered = v_ndc * params.outputSize;',
      '  float angle = atan(centered.y, centered.x);',
      '  angle = angle < 0.0 ? angle + TWO_PI : angle;',
      '  float sector = floor(angle / (TWO_PI / SECTOR_COUNT));',
      '  float sectorMix = 1.0 - step(0.5, abs(sector - params.activeSector));',
      '  outColor = mix(vec4(1.0), texture(source, v_ndc * 0.5 + 0.5), sectorMix);',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileWebPreview(project);

  assert.equal(result.ok, true);
  const wgsl = result.files['shaders/tone.frag.wgsl'];
  const vertexWgsl = result.files['shaders/fullscreen.vert.wgsl'];
  const manifest = JSON.parse(result.files['manifest.json']);
  const sourceBinding = manifest.passes[0].bindings.find((binding) => binding.name === 'source');
  const paramsBinding = manifest.passes[0].bindings.find((binding) => binding.name === 'params');
  assert.match(wgsl, /atan2/);
  assert.match(wgsl, /if \(_e\d+ < 0f\)/);
  assert.match(wgsl, /textureSample\(source_texture, source_sampler,/);
  assert.doesNotMatch(wgsl, /ringSampleImage_source|1\.0 - uv\.y/);
  assert.equal(sourceBinding.binding, 0);
  assert.equal(sourceBinding.samplerBinding, 2);
  assert.equal(paramsBinding.binding, 1);
  assert.match(vertexWgsl, /@binding\(1\)/);
  assert.match(wgsl, /@binding\(1\)/);
  assert.doesNotMatch(wgsl, /const var|\?/);
});

test('web-preview backend appends generated sampler bindings after declared bindings', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 0, binding = 0) uniform Params {',
      '  vec4 tint;',
      '} params;',
      'layout(set = 0, binding = 1) uniform sampler2D sourceA;',
      'layout(set = 0, binding = 2) uniform sampler2D sourceB;',
      'layout(set = 0, binding = 3) uniform Params2 {',
      '  vec4 mixColor;',
      '} params2;',
      '',
      'void main() {',
      '  outColor = texture(sourceA, vec2(0.25)) + texture(sourceB, vec2(0.75)) + params.tint + params2.mixColor;',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileWebPreview(project);
  const manifest = JSON.parse(result.files['manifest.json']);
  const bindings = new Map(manifest.passes[0].bindings.map((binding) => [binding.name, binding]));
  const wgsl = result.files['shaders/tone.frag.wgsl'];

  assert.equal(bindings.get('params').binding, 0);
  assert.equal(bindings.get('sourceA').binding, 1);
  assert.equal(bindings.get('sourceA').samplerBinding, 4);
  assert.equal(bindings.get('sourceB').binding, 2);
  assert.equal(bindings.get('sourceB').samplerBinding, 5);
  assert.equal(bindings.get('params2').binding, 3);
  assert.match(wgsl, /@binding\(0\)/);
  assert.match(wgsl, /@binding\(1\)/);
  assert.match(wgsl, /@binding\(2\)/);
  assert.match(wgsl, /@binding\(3\)/);
  assert.match(wgsl, /@binding\(4\)/);
  assert.match(wgsl, /@binding\(5\)/);
});

test('web-preview backend preserves descriptor sets as WebGPU bind groups', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 2, binding = 0) uniform Params {',
      '  vec4 tint;',
      '} params;',
      'layout(set = 2, binding = 1) uniform sampler2D source;',
      '',
      'void main() {',
      '  outColor = texture(source, vec2(0.5)) + params.tint;',
      '}',
      ''
    ].join('\n')
  });

  const result = await compileWebPreview(project);
  const manifest = JSON.parse(result.files['manifest.json']);
  const bindings = new Map(manifest.passes[0].bindings.map((binding) => [binding.name, binding]));
  const wgsl = result.files['shaders/tone.frag.wgsl'];

  assert.equal(bindings.get('params').set, 2);
  assert.equal(bindings.get('params').binding, 0);
  assert.equal(bindings.get('source').set, 2);
  assert.equal(bindings.get('source').binding, 1);
  assert.equal(bindings.get('source').samplerBinding, 2);
  assert.match(wgsl, /@group\(2\) @binding\(0\)/);
  assert.match(wgsl, /@group\(2\) @binding\(1\)/);
  assert.match(wgsl, /@group\(2\) @binding\(2\)/);
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

  const result = await compileWebPreview(project);
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

    assert.equal(typeof result.files['shaders/tone.frag.wgsl'], 'string');
    assert.equal(typeof result.files['shaders/fullscreen.vert.wgsl'], 'string');
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

  const result = await compileWebPreview(project);

  const wgsl = result.files['shaders/tone.frag.wgsl'];
  assert.match(wgsl, /enabled: u32,/);
  assert.match(wgsl, /strength: f32,/);
  assert.match(wgsl, /mode: i32,/);
  assert.match(wgsl, /count: u32,/);
  assert.match(wgsl, /uv: vec2<f32>,/);
  assert.match(wgsl, /color: vec3<f32>,/);
  assert.match(wgsl, /color2_: vec4<f32>,/);
  assert.match(wgsl, /ij: vec2<i32>,/);
  assert.match(wgsl, /ijk: vec3<i32>,/);
  assert.match(wgsl, /ijkl: vec4<i32>,/);
  assert.match(wgsl, /uij: vec2<u32>,/);
  assert.match(wgsl, /uijk: vec3<u32>,/);
  assert.match(wgsl, /uijkl: vec4<u32>,/);
  assert.match(wgsl, /m3_: mat3x3<f32>,/);
  assert.match(wgsl, /m4_: mat4x4<f32>,/);
  assert.match(wgsl, /if \(_e\d+ != 0u\)/);
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

  const result = await compileWebPreview(project);

  assert.equal(typeof result.files['shaders/histogram.comp.wgsl'], 'string');
  assert.equal(result.files['shaders/histogram.comp.glsl'], undefined);
  assert.match(result.files['shaders/histogram.comp.wgsl'], /struct HistogramBuffer/);
  assert.match(result.files['shaders/histogram.comp.wgsl'], /var<storage, read_write> histogram: HistogramBuffer;/);
  assert.match(result.files['shaders/histogram.comp.wgsl'], /histogram\.bins\[0i\] = 1u;/);
});

test('web-preview backend preserves compute texelFetch texture coordinates', async () => {
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

  const result = await compileWebPreview(project);

  const wgsl = result.files['shaders/histogram.comp.wgsl'];
  assert.match(wgsl, /textureLoad\(source_texture, _e\d+, 0i\)/);
  assert.doesNotMatch(wgsl, /height - 1i - coord\.y/);
  assert.doesNotMatch(wgsl, /ringLoadTexel_source/);
  assert.match(wgsl, /var source_texture: texture_2d<f32>;/);
  assert.match(wgsl, /var source_sampler: sampler;/);
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

  const result = await compileWebPreview(project);

  const wgsl = result.files['shaders/histogram.comp.wgsl'];
  assert.match(wgsl, /histogram\.bins\[/);
  assert.match(wgsl, /atomicAdd\(\(&histogram\.bins\[/);
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

  const result = await compileWebPreview(project);

  const wgsl = result.files['shaders/histogram.comp.wgsl'];
  assert.match(wgsl, /cdf\.values\[/);
  assert.match(wgsl, /histogram\.bins\[/);
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
