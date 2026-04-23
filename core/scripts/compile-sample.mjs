import { compileFilterSourceDirectory } from '../src/node.js';

const sampleDirectory = new URL('../../filter-samples/hdr-luminance-remap/', import.meta.url);
const outputFiles = await compileFilterSourceDirectory(sampleDirectory);
const manifest = JSON.parse(String(outputFiles['manifest.json']));

console.log(JSON.stringify({
  kind: manifest.kind,
  formatVersion: manifest.formatVersion,
  summary: {
    parameterCount: manifest.parameters.length,
    passCount: manifest.passes.length,
    assetCount: manifest.assets.length,
    outputFileCount: Object.keys(outputFiles).length
  },
  outputFiles: Object.keys(outputFiles).map((filePath) => ({
    path: filePath,
    kind: typeof outputFiles[filePath] === 'string' ? 'text' : 'binary'
  }))
}, null, 2));
