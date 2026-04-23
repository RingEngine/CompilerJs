import test from 'node:test';
import assert from 'node:assert/strict';

import { validateFilterSource } from '../../src/index.js';
import { createRenderProject } from './_shared.js';

test('validateFilterSource errors when required root files are missing', async () => {
  const result = await validateFilterSource({
    'manifest.json': JSON.stringify({
      schemaVersion: '1.0.0',
      runtimeVersion: 1,
      passes: []
    }, null, 2)
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'missing_required_file'
  ));
});

test('validateFilterSource errors when required text files are not text', async () => {
  const project = createRenderProject();
  project['main.lua'] = new Uint8Array([0x00, 0x01, 0x02]);

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_text_file'
  ));
});

test('validateFilterSource errors when manifest.json is not valid JSON', async () => {
  const project = createRenderProject();
  project['manifest.json'] = '{ invalid json';

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_manifest_json'
  ));
});

test('validateFilterSource errors when manifest.json root is not an object', async () => {
  const project = createRenderProject();
  project['manifest.json'] = '[]';

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'invalid_manifest_root'
  ));
});

test('validateFilterSource errors when source manifest violates filter-src.schema.json', async () => {
  const project = createRenderProject({
    manifest: {
      passes: [
        {
          id: 'tone',
          type: 'raster'
        }
      ]
    }
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'manifest_schema_error'
  ));
});

test('validateFilterSource reports duplicate parameter ids as errors', async () => {
  const project = createRenderProject({
    manifest: {
      parameters: [
        { id: 'strength', type: 'float', min: 0 },
        { id: 'strength', type: 'float', min: 1 }
      ]
    }
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'duplicate_parameter_id'
  ));
});

test('validateFilterSource reports duplicate pass ids as errors', async () => {
  const project = createRenderProject({
    manifest: {
      passes: [
        {
          id: 'tone',
          type: 'render',
          vertexShader: 'shaders/fullscreen.vert.glsl',
          fragmentShader: 'shaders/tone.frag.glsl'
        },
        {
          id: 'tone',
          type: 'render',
          vertexShader: 'shaders/fullscreen.vert.glsl',
          fragmentShader: 'shaders/tone.frag.glsl'
        }
      ]
    }
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'duplicate_pass_id'
  ));
});

test('validateFilterSource reports duplicate asset ids as errors', async () => {
  const project = createRenderProject({
    manifest: {
      assets: [
        { id: 'mask', type: 'image', path: 'assets/mask-a.png' },
        { id: 'mask', type: 'image', path: 'assets/mask-b.png' }
      ]
    }
  });
  project['assets/mask-a.png'] = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  project['assets/mask-b.png'] = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'duplicate_asset_id'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L308-L327
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L308-L327
test('validateFilterSource errors when manifest-referenced asset files are missing', async () => {
  const project = createRenderProject({
    manifest: {
      assets: [
        {
          id: 'mask',
          type: 'image',
          path: 'assets/mask.png'
        }
      ]
    }
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'missing_asset_file'
  ));
});
