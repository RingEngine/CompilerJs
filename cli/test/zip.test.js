import test from 'node:test';
import assert from 'node:assert/strict';

import { createZipArchive, readZipArchive } from '../src/zip.js';

test('createZipArchive and readZipArchive round-trip stored zip files', () => {
  const archive = createZipArchive({
    'manifest.json': '{"runtimeVersion":1}',
    'assets/blob.bin': new Uint8Array([1, 2, 3])
  });

  const files = readZipArchive(archive);

  assert.equal(files['manifest.json'], '{"runtimeVersion":1}');
  assert.deepEqual(Array.from(files['assets/blob.bin']), [1, 2, 3]);
});
