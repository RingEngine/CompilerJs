import test from 'node:test';

import { FILTER_SCHEMA_URL, FILTER_SRC_SCHEMA_URL } from '../../src/schema-urls.js';

const originalFetch = globalThis.fetch;
const filterSrcSchema = await fetchSchema(FILTER_SRC_SCHEMA_URL);
const filterSchema = await fetchSchema(FILTER_SCHEMA_URL);

function installSchemaFetchMock() {
  globalThis.fetch = async (url) => {
    if (url === FILTER_SRC_SCHEMA_URL) {
      return makeJsonResponse(filterSrcSchema);
    }

    if (url === FILTER_SCHEMA_URL) {
      return makeJsonResponse(filterSchema);
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function makeJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return payload;
    }
  };
}

async function fetchSchema(url) {
  const response = await originalFetch(url, {
    headers: {
      accept: 'application/schema+json, application/json'
    }
  });

  if (!response?.ok) {
    throw new Error(`Failed to load schema fixture from ${url}: ${response?.status} ${response?.statusText}`);
  }

  return await response.json();
}

export function createRenderProject(overrides = {}) {
  const manifest = {
    $schema: FILTER_SRC_SCHEMA_URL,
    schemaVersion: '1.0.0',
    runtimeVersion: 1,
    passes: [
      {
        id: 'tone',
        type: 'render',
        vertexShader: 'shaders/fullscreen.vert.glsl',
        fragmentShader: 'shaders/tone.frag.glsl'
      }
    ],
    ...overrides.manifest
  };

  return {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'main.lua': overrides.mainLua ?? [
      'function onReset(ctx)',
      'end',
      '',
      'function advance(ctx)',
      'end',
      ''
    ].join('\n'),
    'shaders/fullscreen.vert.glsl': overrides.vertexShader ?? [
      '#version 450',
      '',
      'layout(location = 0) in vec2 a_position;',
      '',
      'void main() {',
      '  gl_Position = vec4(a_position, 0.0, 1.0);',
      '}',
      ''
    ].join('\n'),
    'shaders/tone.frag.glsl': overrides.fragmentShader ?? [
      '#version 450',
      '',
      'layout(location = 0) out vec4 outColor;',
      '',
      'void main() {',
      '  outColor = vec4(1.0);',
      '}',
      ''
    ].join('\n')
  };
}

export function createComputeProject(overrides = {}) {
  const manifest = {
    $schema: FILTER_SRC_SCHEMA_URL,
    schemaVersion: '1.0.0',
    runtimeVersion: 1,
    passes: [
      {
        id: 'histogram',
        type: 'compute',
        computeShader: 'shaders/histogram.comp.glsl'
      }
    ],
    ...overrides.manifest
  };

  return {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'main.lua': overrides.mainLua ?? [
      'function onReset(ctx)',
      'end',
      '',
      'function advance(ctx)',
      'end',
      ''
    ].join('\n'),
    'shaders/histogram.comp.glsl': overrides.computeShader ?? [
      '#version 450',
      '',
      'layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;',
      '',
      'void main() {',
      '}',
      ''
    ].join('\n')
  };
}

test.beforeEach(() => {
  installSchemaFetchMock();
});

test.after(() => {
  restoreFetch();
});
