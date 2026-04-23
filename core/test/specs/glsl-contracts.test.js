import test from 'node:test';
import assert from 'node:assert/strict';

import { validateFilterSource } from '../../src/index.js';
import { createComputeProject, createRenderProject } from './_shared.js';

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L269-L283
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L269-L283
test('validateFilterSource warns when render vertex shader does not expose exactly one vec2 input', async () => {
  const project = createRenderProject({
    vertexShader: [
      '#version 450',
      '',
      'layout(location = 0) in vec2 a_position;',
      'layout(location = 1) in vec2 a_uv;',
      '',
      'void main() {',
      '  gl_Position = vec4(a_position, 0.0, 1.0);',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'unexpected_render_vertex_input_shape'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L271-L278
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L288-L294
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L271-L278
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L288-L294
test('validateFilterSource errors when manifest-referenced shader files are missing', async () => {
  const project = createRenderProject({
    manifest: {
      passes: [
        {
          id: 'tone',
          type: 'render',
          vertexShader: 'shaders/fullscreen.vert.glsl',
          fragmentShader: 'shaders/missing.frag.glsl'
        }
      ]
    }
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'missing_shader_file'
  ));
});

test('validateFilterSource errors when manifest-referenced shader files are not text', async () => {
  const project = createRenderProject();
  project['shaders/tone.frag.glsl'] = new Uint8Array([0x03, 0x02, 0x23]);

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_shader_file'
  ));
});

test('validateFilterSource errors on GLSL parse failures', async () => {
  const project = createRenderProject({
    fragmentShader: [
      '#version 450',
      'layout(location = 0) out vec4 outColor;',
      'void main( {',
      '  outColor = vec4(1.0);',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'glsl_parse_error'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L286-L306
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L286-L306
test('validateFilterSource errors when storage buffer blocks declare multiple members', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) buffer HistogramBuffer {',
      '  uint bins[];',
      '  uint total;',
      '} histogram;',
      '',
      'void main() {',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_buffer_member_count'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L286-L306
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L286-L306
test('validateFilterSource errors when storage buffer blocks declare a non-array member', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) buffer HistogramBuffer {',
      '  uint bins;',
      '} histogram;',
      '',
      'void main() {',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_buffer_member_shape'
  ));
});

test('validateFilterSource errors when shader bindings use unsupported binding types', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) uniform image2D storageImage;',
      '',
      'void main() {',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unsupported_binding_type'
  ));
});

test('validateFilterSource errors when storage buffers use unsupported element types', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) buffer HistogramBuffer {',
      '  vec4 bins[];',
      '} histogram;',
      '',
      'void main() {',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unsupported_buffer_element_type'
  ));
});

test('validateFilterSource errors when uniform blocks use unsupported field types', async () => {
  const project = createComputeProject({
    computeShader: [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      'layout(set = 0, binding = 0) uniform Params {',
      '  double exposure;',
      '} params;',
      '',
      'void main() {',
      '}',
      ''
    ].join('\n')
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unsupported_uniform_field_type'
  ));
});
