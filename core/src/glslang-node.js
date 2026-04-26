import initialize from '@webgpu/glslang/dist/web-devel-onefile/glslang.js';

export async function createNodeShaderCompiler() {
  const glslangMessages = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    glslangMessages.push(args.map((item) => String(item)).join(' '));
  };

  let glslang;
  try {
    glslang = await initialize();
  } finally {
    console.warn = originalWarn;
  }

  return {
    async compileGLSL(source, stage, options = {}) {
      glslangMessages.length = 0;
      const currentWarn = console.warn;
      console.warn = (...args) => {
        glslangMessages.push(args.map((item) => String(item)).join(' '));
      };

      try {
        return glslang.compileGLSL(
          source,
          stage,
          options.debug ?? true,
          options.spirvVersion ?? '1.0'
        );
      } catch (error) {
        error.compilerLog = glslangMessages.join('\n').trim();
        throw error;
      } finally {
        console.warn = currentWarn;
      }
    }
  };
}
