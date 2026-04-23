import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCompiledManifestAgainstSchema } from '../../src/compiled-manifest-schema.js';
import { FILTER_SCHEMA_URL } from '../../src/schema-urls.js';

test('validateCompiledManifestAgainstSchema rejects compiled manifests that violate filter.schema.json', async () => {
  const diagnostics = await validateCompiledManifestAgainstSchema({
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

  assert.ok(diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'compiled_manifest_schema_error'
  ));
});
