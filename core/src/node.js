import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFilterSourceFiles } from './index.js';
import { createNodeShaderCompiler } from './glslang-node.js';

/**
 * Read a directory from disk into the compiler core's in-memory file format.
 *
 * @param {string} rootDirectory
 * @returns {Record<string, string|Uint8Array>}
 */
export function readFilterSourceDirectory(rootDirectory) {
  const resolvedRootDirectory = resolveNodePath(rootDirectory);
  const result = {};
  walkDirectory(resolvedRootDirectory, resolvedRootDirectory, result);
  return result;
}

/**
 * @param {string} rootDirectory
 * @param {{ sourceName?: string }} [options]
 */
export async function compileFilterSourceDirectory(rootDirectory, options = {}) {
  const resolvedRootDirectory = resolveNodePath(rootDirectory);
  const files = readFilterSourceDirectory(resolvedRootDirectory);
  const compiler = options.compiler ?? await createNodeShaderCompiler();
  return await compileFilterSourceFiles(files, {
    sourceName: options.sourceName ?? path.basename(resolvedRootDirectory)
    , compiler
  });
}

function resolveNodePath(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

function walkDirectory(rootDirectory, currentDirectory, output) {
  const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = path.relative(rootDirectory, absolutePath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      walkDirectory(rootDirectory, absolutePath, output);
      continue;
    }

    const bytes = fs.readFileSync(absolutePath);
    if (isTextPath(relativePath)) {
      output[relativePath] = bytes.toString('utf8');
    } else {
      output[relativePath] = new Uint8Array(bytes);
    }
  }
}

function isTextPath(filePath) {
  const normalized = filePath.toLowerCase();
  return normalized.endsWith('.json')
    || normalized.endsWith('.lua')
    || normalized.endsWith('.glsl')
    || normalized.endsWith('.md')
    || normalized.endsWith('.txt')
    || normalized.endsWith('.yaml')
    || normalized.endsWith('.yml');
}
