import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const tagName = String(process.env.GIT_TAG || process.argv[2] || '').trim();
const rootDirectory = process.cwd();

if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
  throw new Error(`Invalid release tag format: "${tagName}". Expected v0.0.0.`);
}

const version = tagName.slice(1);
const packageFiles = [
  'core/package.json',
  'packer/package.json',
  'cli/package.json'
];

for (const relativePath of packageFiles) {
  const absolutePath = path.join(rootDirectory, relativePath);
  const packageJson = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
  if (packageJson.version !== version) {
    throw new Error(`${relativePath} version ${packageJson.version} does not match tag ${tagName}.`);
  }
}

console.log(JSON.stringify({
  ok: true,
  tag: tagName,
  version
}, null, 2));
