import fs from 'node:fs/promises';
import path from 'node:path';

export async function readDirectoryAsFileMap(rootDirectory) {
  const files = {};
  const resolvedRoot = path.resolve(rootDirectory);
  await walkDirectory(resolvedRoot, resolvedRoot, files);
  return files;
}

export async function writeFileMapToDirectory(rootDirectory, files) {
  const resolvedRoot = path.resolve(rootDirectory);
  await fs.mkdir(resolvedRoot, { recursive: true });

  for (const [relativePath, value] of Object.entries(files)) {
    const absolutePath = path.join(resolvedRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    if (typeof value === 'string') {
      await fs.writeFile(absolutePath, value, 'utf8');
      continue;
    }

    await fs.writeFile(absolutePath, value);
  }
}

export async function resolveInputValue({ direct = null, file = null, url = null }) {
  if (direct !== null && direct !== undefined) {
    return direct;
  }

  if (file) {
    return await fs.readFile(path.resolve(file), 'utf8');
  }

  if (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load URL: ${url} (${response.status} ${response.statusText})`);
    }
    return await response.text();
  }

  return null;
}

async function walkDirectory(rootDirectory, currentDirectory, output) {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = path.relative(rootDirectory, absolutePath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await walkDirectory(rootDirectory, absolutePath, output);
      continue;
    }

    const bytes = await fs.readFile(absolutePath);
    output[relativePath] = isTextPath(relativePath)
      ? bytes.toString('utf8')
      : new Uint8Array(bytes);
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
