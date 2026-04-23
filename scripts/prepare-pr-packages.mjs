import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDirectory = process.cwd();
const prNumber = readRequiredNumber('PR_NUMBER');
const runNumber = readRequiredNumber('RUN_NUMBER');
const prereleaseVersion = `0.0.0-pr.${prNumber}.${runNumber}`;
const outputDirectory = path.join(rootDirectory, '.artifacts', `pr-${prNumber}`);

const packageDefinitions = [
  {
    directory: 'core',
    name: '@ring-engine-org/filter-compiler-core',
    extraPackageJson: {
      version: prereleaseVersion
    }
  },
  {
    directory: 'packer',
    name: '@ring-engine-org/filter-packer',
    extraPackageJson: {
      version: prereleaseVersion
    }
  },
  {
    directory: 'cli',
    name: '@ring-engine-org/filter-cli',
    extraPackageJson: {
      version: prereleaseVersion,
      dependencies: {
        '@ring-engine-org/filter-compiler-core': prereleaseVersion,
        '@ring-engine-org/filter-packer': prereleaseVersion
      }
    }
  }
];

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });

for (const definition of packageDefinitions) {
  await preparePackage(definition);
}

await fs.writeFile(
  path.join(outputDirectory, 'README.txt'),
  [
    `PR preview packages for PR #${prNumber}`,
    `Version: ${prereleaseVersion}`,
    '',
    'These tarballs are temporary CI artifacts.',
    'They are intended for preview/testing and are not published to npm.'
  ].join('\n'),
  'utf8'
);

console.log(JSON.stringify({
  ok: true,
  outputDirectory,
  prereleaseVersion
}, null, 2));

async function preparePackage(definition) {
  const sourceDirectory = path.join(rootDirectory, definition.directory);
  const targetDirectory = path.join(outputDirectory, definition.directory);
  await fs.mkdir(targetDirectory, { recursive: true });

  const sourcePackageJsonPath = path.join(sourceDirectory, 'package.json');
  const sourcePackageJson = JSON.parse(await fs.readFile(sourcePackageJsonPath, 'utf8'));
  const nextPackageJson = mergePackageJson(sourcePackageJson, definition.extraPackageJson);

  await fs.writeFile(
    path.join(targetDirectory, 'package.json'),
    JSON.stringify(nextPackageJson, null, 2) + '\n',
    'utf8'
  );

  for (const relativePath of definitionFiles(sourcePackageJson)) {
    const sourcePath = path.join(sourceDirectory, relativePath);
    const targetPath = path.join(targetDirectory, relativePath);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    await fs.cp(sourcePath, targetPath, { recursive: true });
  }
}

function definitionFiles(packageJson) {
  const listedFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  return Array.from(new Set(['README.md', ...listedFiles]))
    .filter((value) => value !== 'package.json');
}

function mergePackageJson(basePackageJson, extraPackageJson) {
  const merged = {
    ...basePackageJson,
    ...extraPackageJson
  };

  if (extraPackageJson.dependencies) {
    merged.dependencies = {
      ...(basePackageJson.dependencies ?? {}),
      ...extraPackageJson.dependencies
    };
  }

  return merged;
}

function readRequiredNumber(name) {
  const value = Number.parseInt(String(process.env[name] ?? ''), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Missing or invalid ${name}.`);
  }
  return value;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
