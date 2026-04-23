import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/main.js');

test('compiler CLI checks source, compiles, packs directories into rfp, lists, and unpacks packages', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ring-compiler-js-cli-'));
  const sourceDirectory = path.join(tempRoot, 'source');
  const compileOutputDirectory = path.join(tempRoot, 'compiled');
  const unpackCompiledOutputDirectory = path.join(tempRoot, 'unpacked-compiled');
  const unpackSourceOutputDirectory = path.join(tempRoot, 'unpacked-source');
  const packagePath = path.join(tempRoot, 'filter.rfp');
  const sourcePackagePath = path.join(tempRoot, 'filter-source.rfp');
  const privateKeyPath = path.join(tempRoot, 'private.pem');
  const publicKeyPath = path.join(tempRoot, 'public.pem');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  await writeSampleFilterSource(sourceDirectory);
  await fs.writeFile(privateKeyPath, privateKey, 'utf8');
  await fs.writeFile(publicKeyPath, publicKey, 'utf8');

  const server = await createTextServer({
    '/public': publicKey
  });

  try {
    const checkResult = await execCli([
      'check-source',
      '--input', sourceDirectory
    ]);
    const checkSummary = JSON.parse(checkResult.stdout);
    assert.equal(checkSummary.ok, true);
    assert.equal(checkSummary.warningCount, 0);

    const compileResult = await execCli([
      'compile',
      '--input', sourceDirectory,
      '--output', compileOutputDirectory
    ]);
    const compileSummary = JSON.parse(compileResult.stdout);
    assert.equal(compileSummary.ok, true);
    assert.ok(compileSummary.outputFileCount >= 4);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(compileOutputDirectory, 'manifest.json'), 'utf8')).kind,
      'filter'
    );

    const packResult = await execCli([
      'pack',
      '--input', compileOutputDirectory,
      '--output', packagePath,
      '--master-key', 'master-secret',
      '--private-key-file', privateKeyPath
    ]);
    const packSummary = JSON.parse(packResult.stdout);
    assert.equal(packSummary.ok, true);
    assert.equal(packSummary.outputKind, 'filter-package');
    assert.equal(packSummary.includeCompiling, false);
    assert.equal(packSummary.signed, true);

    const listResult = await execCli([
      'list',
      '--input', packagePath,
      '--master-key', 'master-secret',
      '--public-key-url', `${server.baseUrl}/public`
    ]);
    const listed = JSON.parse(listResult.stdout);
    assert.equal(listed.verified, true);
    assert.ok(listed.files.some((entry) => entry.path === 'manifest.json'));
    assert.ok(listed.files.some((entry) => entry.path.endsWith('.spv')));

    await execCli([
      'unpack',
      '--input', packagePath,
      '--output', unpackCompiledOutputDirectory,
      '--master-key', 'master-secret',
      '--public-key-file', publicKeyPath
    ]);

    assert.equal(
      JSON.parse(await fs.readFile(path.join(unpackCompiledOutputDirectory, 'manifest.json'), 'utf8')).kind,
      'filter'
    );
    assert.deepEqual(
      Array.from(await fs.readFile(path.join(unpackCompiledOutputDirectory, 'shaders', 'fullscreen.vert.spv'))).slice(0, 4),
      Array.from(await fs.readFile(path.join(compileOutputDirectory, 'shaders', 'fullscreen.vert.spv'))).slice(0, 4)
    );

    const packSourceResult = await execCli([
      'pack',
      '--input', sourceDirectory,
      '--output', sourcePackagePath,
      '--master-key', 'master-secret',
      '--include-compiling'
    ]);
    const packSourceSummary = JSON.parse(packSourceResult.stdout);
    assert.equal(packSourceSummary.ok, true);
    assert.equal(packSourceSummary.includeCompiling, true);
    assert.equal(packSourceSummary.signed, false);

    await execCli([
      'unpack',
      '--input', sourcePackagePath,
      '--output', unpackSourceOutputDirectory,
      '--master-key', 'master-secret'
    ]);

    assert.equal(
      JSON.parse(await fs.readFile(path.join(unpackSourceOutputDirectory, 'manifest.json'), 'utf8')).kind,
      'filter'
    );
  } finally {
    await closeServer(server.server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function writeSampleFilterSource(targetDirectory) {
  await fs.mkdir(path.join(targetDirectory, 'shaders'), { recursive: true });

  await fs.writeFile(path.join(targetDirectory, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    runtimeVersion: 1,
    metadata: {
      kind: 'filter-src',
      id: 'com.example.cli-test',
      name: 'CLI Test Filter',
      version: '1.0.0'
    },
    passes: [
      {
        id: 'tone',
        type: 'render',
        vertexShader: 'shaders/fullscreen.vert.glsl',
        fragmentShader: 'shaders/tone.frag.glsl'
      }
    ]
  }, null, 2));

  await fs.writeFile(path.join(targetDirectory, 'main.lua'), `function onReset(ctx)
end

function advance(ctx)
  ctx:runRenderPass("tone", {
    source = ctx:getInput()
  }, ctx:getOutput())
end
`);

  await fs.writeFile(path.join(targetDirectory, 'shaders', 'fullscreen.vert.glsl'), `#version 450

layout(location = 0) in vec2 a_position;
layout(location = 0) out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`);

  await fs.writeFile(path.join(targetDirectory, 'shaders', 'tone.frag.glsl'), `#version 450

layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 outColor;

layout(set = 0, binding = 0) uniform sampler2D source;

void main() {
  outColor = texture(source, v_uv);
}
`);
}

async function execCli(args) {
  return await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: path.resolve('.')
  });
}

async function createTextServer(routes) {
  const server = http.createServer((request, response) => {
    const payload = routes[request.url || ''];
    if (payload === undefined) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(payload);
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address.');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
