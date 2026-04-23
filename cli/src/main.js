#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { FilterCompilerError, compileFilterSourceFiles, validateFilterSource } from '../../core/src/index.js';
import { createNodeShaderCompiler } from '../../core/src/glslang-node.js';
import { readFilterSourceDirectory } from '../../core/src/node.js';
import { listFilterPackage, packFilterPackage, unpackFilterPackage, MAGIC } from '../../packer/src/index.js';
import { readZipArchive } from './zip.js';
import { readDirectoryAsFileMap, resolveInputValue, writeFileMapToDirectory } from './io.js';

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

try {
  switch (command) {
    case 'check-source':
      await handleCheck(args);
      break;
    case 'compile':
      await handleCompile(args);
      break;
    case 'pack':
      await handlePack(args);
      break;
    case 'list':
      await handleList(args);
      break;
    case 'unpack':
      await handleUnpack(args);
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
} catch (error) {
  printCommandError(error);
  process.exitCode = 1;
}

async function handleCheck(args) {
  const input = requireArg(args, 'input');
  const sourceFiles = readFilterSourceDirectory(input);
  const validation = await validateFilterSource(sourceFiles);
  printDiagnostics(validation.diagnostics);

  if (!validation.ok) {
    throw new CliDiagnosticsError('Source project validation failed.', validation.diagnostics, true);
  }

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: path.resolve(input),
    warningCount: countDiagnostics(validation.diagnostics, 'warning'),
    diagnosticCount: validation.diagnostics.length
  }, null, 2));
}

async function handleCompile(args) {
  const input = requireArg(args, 'input');
  const output = requireArg(args, 'output');
  const compiledFiles = await compileSourceDirectory(input);
  await writeFileMapToDirectory(output, compiledFiles);

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: path.resolve(input),
    outputDirectory: path.resolve(output),
    outputFileCount: Object.keys(compiledFiles).length,
    files: summarizeVirtualFiles(compiledFiles)
  }, null, 2));
}

async function handlePack(args) {
  const input = requireArg(args, 'input');
  const output = requireArg(args, 'output');
  const masterKey = args['master-key'] ?? null;
  if (masterKey === null) {
    throw new Error('Formal package packing requires --master-key.');
  }

  const privateKey = await resolveSecretArg(args, 'private-key');
  const includeCompiling = Boolean(args['include-compiling']);
  const files = includeCompiling
    ? await compileSourceDirectory(input)
    : await readDirectoryAsFileMap(input);
  const packed = await packFilterPackage({
    masterKey,
    privateKey,
    files
  });
  await fs.writeFile(path.resolve(output), packed);

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: path.resolve(input),
    outputPath: path.resolve(output),
    outputKind: 'filter-package',
    includeCompiling,
    signed: privateKey !== null,
    fileCount: Object.keys(files).length
  }, null, 2));
}

async function handleList(args) {
  const input = requireArg(args, 'input');
  const bytes = new Uint8Array(await fs.readFile(path.resolve(input)));

  if (isFilterPackage(bytes)) {
    const header = listFilterPackage(bytes);
    const masterKey = args['master-key'] ?? null;
    const publicKey = await resolveSecretArg(args, 'public-key');
    if (masterKey === null) {
      console.log(JSON.stringify(header, null, 2));
      return;
    }

    const unpacked = await unpackFilterPackage(bytes, {
      masterKey,
      publicKey,
      listOnly: true
    });
    console.log(JSON.stringify({
      ...header,
      verified: unpacked.verified,
      files: unpacked.files
    }, null, 2));
    return;
  }

  const zipFiles = readZipArchive(bytes);
  console.log(JSON.stringify({
    format: 'zip',
    files: Object.entries(zipFiles).map(([filePath, value]) => ({
      path: filePath,
      kind: typeof value === 'string' ? 'text' : 'binary',
      size: typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength
    }))
  }, null, 2));
}

async function handleUnpack(args) {
  const input = requireArg(args, 'input');
  const output = requireArg(args, 'output');
  const bytes = new Uint8Array(await fs.readFile(path.resolve(input)));

  if (isFilterPackage(bytes)) {
    const masterKey = args['master-key'] ?? null;
    if (masterKey === null) {
      throw new Error('Formal package unpacking requires --master-key.');
    }

    const publicKey = await resolveSecretArg(args, 'public-key');
    const unpacked = await unpackFilterPackage(bytes, {
      masterKey,
      publicKey
    });
    await writeFileMapToDirectory(output, unpacked.files);
    return;
  }

  const files = readZipArchive(bytes);
  await writeFileMapToDirectory(output, files);
}

async function resolveSecretArg(args, baseName) {
  return await resolveInputValue({
    direct: args[baseName] ?? null,
    file: args[`${baseName}-file`] ?? null,
    url: args[`${baseName}-url`] ?? null
  });
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required --${key} argument.`);
  }
  return value;
}

function parseArgs(rawArgs) {
  const result = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = rawArgs[index + 1];
    if (value === undefined || value.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function isFilterPackage(bytes) {
  return bytes.byteLength >= MAGIC.byteLength
    && MAGIC.every((byte, index) => bytes[index] === byte);
}

async function compileSourceDirectory(inputDirectory) {
  const resolvedInput = path.resolve(inputDirectory);
  const sourceFiles = readFilterSourceDirectory(resolvedInput);
  const validation = await validateFilterSource(sourceFiles);
  printDiagnostics(validation.diagnostics);

  if (!validation.ok) {
    throw new CliDiagnosticsError('Source project validation failed.', validation.diagnostics, true);
  }

  const compiler = await createNodeShaderCompiler();
  return await compileFilterSourceFiles(sourceFiles, {
    sourceName: path.basename(resolvedInput),
    compiler
  });
}

function printDiagnostics(diagnostics) {
  for (const diagnostic of diagnostics ?? []) {
    console.error(formatDiagnostic(diagnostic));
  }
}

function formatDiagnostic(diagnostic) {
  const severity = String(diagnostic?.severity || 'error').toUpperCase();
  const code = diagnostic?.code || 'unknown';
  const location = formatDiagnosticLocation(diagnostic);
  const message = diagnostic?.message || 'Unknown error.';
  return location
    ? `${severity} ${code} ${location} ${message}`
    : `${severity} ${code} ${message}`;
}

function formatDiagnosticLocation(diagnostic) {
  if (!diagnostic?.path) return '';
  const line = Number.isInteger(diagnostic.line) ? diagnostic.line : null;
  const column = Number.isInteger(diagnostic.column) ? diagnostic.column + 1 : null;

  if (line !== null && column !== null) return `${diagnostic.path}:${line}:${column}`;
  if (line !== null) return `${diagnostic.path}:${line}`;
  return diagnostic.path;
}

function countDiagnostics(diagnostics, severity) {
  return diagnostics.filter((item) => item.severity === severity).length;
}

function summarizeVirtualFiles(files) {
  return Object.entries(files).map(([filePath, value]) => ({
    path: filePath,
    kind: typeof value === 'string' ? 'text' : 'binary',
    size: typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength
  }));
}

function printCommandError(error) {
  if (error?.name === 'CliDiagnosticsError') {
    if (!error.diagnosticsPrinted) {
      printDiagnostics(error.diagnostics);
    }
    return;
  }

  if (error instanceof FilterCompilerError) {
    printDiagnostics(error.diagnostics);
    return;
  }

  console.error(error.message || String(error));
}

class CliDiagnosticsError extends Error {
  constructor(message, diagnostics, diagnosticsPrinted = false) {
    super(message);
    this.name = 'CliDiagnosticsError';
    this.diagnostics = diagnostics;
    this.diagnosticsPrinted = diagnosticsPrinted;
  }
}

function printUsage() {
  console.log([
    'rfc2 check-source --input <filter-src-dir>',
    'rfc2 compile --input <filter-src-dir> --output <compiled-dir>',
    'rfc2 pack --input <dir> --output <file.rfp> --master-key <value> [--include-compiling] [--private-key <pem>|--private-key-file <path>|--private-key-url <url>]',
    'rfc2 list --input <file> [--master-key <value>] [--public-key <pem>|--public-key-file <path>|--public-key-url <url>]',
    'rfc2 unpack --input <file> --output <dir> [--master-key <value>] [--public-key <pem>|--public-key-file <path>|--public-key-url <url>]'
  ].join('\n'));
}
