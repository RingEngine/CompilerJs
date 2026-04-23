import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  COMPRESSION_DEFLATE_RAW,
  FORMAT_VERSION,
  HEADER_LENGTH,
  listFilterPackage,
  packFilterPackage,
  unpackFilterPackage
} from '../src/index.js';

test('packFilterPackage and unpackFilterPackage round-trip signed packages', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const sourceFiles = {
    'manifest.json': '{"runtimeVersion":1}',
    'main.lua': 'function onReset(ctx)\nend\n',
    'assets/blob.bin': new Uint8Array([1, 2, 3, 4])
  };

  const packed = await packFilterPackage({
    masterKey: 'master-secret',
    privateKey,
    files: sourceFiles
  });

  const listed = listFilterPackage(packed);
  assert.equal(listed.formatVersion, FORMAT_VERSION);
  assert.equal(listed.signed, true);
  assert.equal(listed.entryCount, 3);

  const unpacked = await unpackFilterPackage(packed, {
    masterKey: 'master-secret',
    publicKey
  });

  assert.equal(unpacked.verified, true);
  assert.equal(unpacked.files['manifest.json'], sourceFiles['manifest.json']);
  assert.equal(unpacked.files['main.lua'], sourceFiles['main.lua']);
  assert.deepEqual(Array.from(unpacked.files['assets/blob.bin']), [1, 2, 3, 4]);
});

test('unpackFilterPackage supports listOnly without decoding entries', async () => {
  const packed = await packFilterPackage({
    masterKey: 'master-secret',
    files: {
      'manifest.json': '{"runtimeVersion":1}',
      'main.lua': 'function advance(ctx)\nend\n'
    }
  });

  const result = await unpackFilterPackage(packed, {
    masterKey: 'master-secret',
    listOnly: true
  });

  assert.equal(result.verified, null);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].compression, COMPRESSION_DEFLATE_RAW);
});

test('signed package verification fails after payload tampering', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const packed = await packFilterPackage({
    masterKey: 'master-secret',
    privateKey,
    files: {
      'manifest.json': '{"runtimeVersion":1}'
    }
  });

  const header = listFilterPackage(packed);
  packed[HEADER_LENGTH + header.entryListLength + 5] ^= 0xff;

  const unpacked = await unpackFilterPackage(packed, {
    masterKey: 'master-secret',
    publicKey,
    listOnly: true
  });

  assert.equal(unpacked.verified, false);
});
