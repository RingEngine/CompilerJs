import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFilterSourceFilesWithDiagnostics } from './index.js';
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
  const result = await compileFilterSourceDirectoryWithDiagnostics(rootDirectory, options);
  return result.files;
}

/**
 * @param {string} rootDirectory
 * @param {{ sourceName?: string, backend?: 'spirv'|'web-preview', compiler?: import('./index.js').ShaderCompiler, spirvVersion?: '1.0'|'1.1'|'1.2'|'1.3'|'1.4'|'1.5' }} [options]
 */
export async function compileFilterSourceDirectoryWithDiagnostics(rootDirectory, options = {}) {
  const resolvedRootDirectory = resolveNodePath(rootDirectory);
  const files = readFilterSourceDirectory(resolvedRootDirectory);
  const backend = options.backend ?? 'spirv';
  const compiler = backend === 'spirv' || backend === 'web-preview'
    ? options.compiler ?? await createNodeShaderCompiler()
    : options.compiler;
  return await compileFilterSourceFilesWithDiagnostics(files, {
    sourceName: options.sourceName ?? path.basename(resolvedRootDirectory),
    backend,
    compiler,
    spirvVersion: options.spirvVersion
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
