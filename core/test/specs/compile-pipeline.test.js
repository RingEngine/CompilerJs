import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FilterCompilerError,
  compileFilterSourceFiles,
  compileFilterSourceFilesWithDiagnostics
} from '../../src/index.js';
import { createNodeShaderCompiler } from '../../src/glslang-node.js';
import { createRenderProject } from './_shared.js';

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
      assert.match(error.diagnostics[0].message, /Source excerpt:/);
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
