import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FilterCompilerError,
  compileFilterSourceFiles,
  compileFilterSourceFilesWithDiagnostics
} from '../../src/index.js';
import { createNodeShaderCompiler } from '../../src/glslang-node.js';
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

test('web-preview backend emits preprocessed GLSL with line maps without SPIR-V', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '#include "shared/color.glsl"',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'void main() {',
      '  outColor = sharedColor();',
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
  assert.equal(typeof result.files['shaders/tone.frag.glsl'], 'string');
  assert.equal(result.files['shaders/tone.frag.spv'], undefined);
  assert.match(result.files['shaders/tone.frag.glsl'], /sharedColor/);

  const lineMap = JSON.parse(result.files['shaders/tone.frag.glsl.map.json']);
  assert.ok(lineMap.some((entry) =>
    entry.path === 'shaders/shared/color.glsl' && entry.line === 1
  ));

  const manifest = JSON.parse(result.files['manifest.json']);
  assert.equal(manifest.passes[0].stages.fragment, 'shaders/tone.frag.glsl');
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

test('compiler injects std140 for uniform blocks before backend output', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'layout(set = 0, binding = 0) uniform OverlayParams {',
      '  vec4 color;',
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

  assert.match(
    result.files['shaders/tone.frag.glsl'],
    /layout\(std140, set = 0, binding = 0\) uniform OverlayParams/
  );
});

test('compiler injects std430 for storage buffers before backend output', async () => {
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

  assert.match(
    result.files['shaders/histogram.comp.glsl'],
    /layout\(std430, set = 0, binding = 0\) buffer HistogramBuffer/
  );
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
