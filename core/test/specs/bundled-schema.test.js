import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCompiledManifestAgainstSchema } from '../../src/compiled-manifest-schema.js';
import { validateFilterSource } from '../../src/index.js';
import { FILTER_SCHEMA_URL } from '../../src/schema-urls.js';
import { createRenderProject } from './_shared.js';

test('schema validation uses bundled schemas without runtime fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('schema validation must not fetch at runtime');
  };

  try {
    const sourceResult = await validateFilterSource(createRenderProject({
      manifest: {
        passes: [
          {
            id: 'tone',
            type: 'raster'
          }
        ]
      }
    }));
    assert.equal(sourceResult.ok, false);
    assert.ok(sourceResult.diagnostics.some((item) =>
      item.severity === 'error' && item.code === 'manifest_schema_error'
    ));

    const compiledDiagnostics = await validateCompiledManifestAgainstSchema({
      $schema: FILTER_SCHEMA_URL,
      kind: 'filter',
      formatVersion: '0.2.0',
      sourceSchemaVersion: '1.0.0',
      runtimeVersion: 1,
      outputSizeMode: 'passive',
      mainScript: 'main.lua',
      passes: [
        {
          id: 'tone',
          type: 'render',
          stages: {
            vertex: 'shaders/fullscreen.vert.spv',
            fragment: 'shaders/tone.frag.spv'
          },
          vertexInput: [
            { name: 'a_position', location: 0, type: 'vec2' }
          ]
        }
      ]
    });
    assert.ok(compiledDiagnostics.some((item) =>
      item.severity === 'error' && item.code === 'compiled_manifest_schema_error'
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
