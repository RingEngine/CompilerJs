import initialize from '@webgpu/glslang/dist/web-devel-onefile/glslang.js';

export async function createBrowserShaderCompiler() {
  const glslang = await initialize();
  return {
    async compileGLSL(source, stage, options = {}) {
      return glslang.compileGLSL(
        source,
        stage,
        options.debug ?? true,
        options.spirvVersion ?? '1.0'
      );
    }
  };
}
