import test from 'node:test';
import assert from 'node:assert/strict';

import { FilterCompilerError, compileFilterSourceFiles } from '../../src/index.js';
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
      return true;
    }
  );
});
