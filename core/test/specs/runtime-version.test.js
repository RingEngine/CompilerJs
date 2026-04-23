import test from 'node:test';
import assert from 'node:assert/strict';

import { validateFilterSource, validateManifestRuntimeVersion } from '../../src/index.js';
import { COMPILER_RUNTIME_VERSION } from '../../src/compiler-config.js';
import { createRenderProject } from './_shared.js';

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L84-L94
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L84-L94
test('validateFilterSource errors when manifest runtimeVersion is newer than the compiler runtimeVersion', async () => {
  const project = createRenderProject({
    manifest: {
      runtimeVersion: COMPILER_RUNTIME_VERSION + 1
    }
  });

  const result = await validateFilterSource(project);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) =>
    item.severity === 'error' && item.code === 'unsupported_runtime_version'
  ));
});

// Spec:
// EN: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.md?plain=1#L84-L94
// ZH: https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_SRC.zh-CN.md?plain=1#L84-L94
test('validateManifestRuntimeVersion warns when manifest runtimeVersion is older than the compiler runtimeVersion', () => {
  const diagnostics = [];

  validateManifestRuntimeVersion({
    runtimeVersion: COMPILER_RUNTIME_VERSION - 1
  }, diagnostics);

  assert.ok(diagnostics.some((item) =>
    item.severity === 'warning' && item.code === 'older_runtime_version'
  ));
});
