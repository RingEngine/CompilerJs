import pako from 'pako';

const MAGIC = new Uint8Array([0x52, 0x50, 0x4b, 0x47]); // RPKG
const FORMAT_VERSION = 1;
const HEADER_LENGTH = 4 + 2 + 2 + 16 + 4 + 4 + 256;
const FLAG_SIGNED = 1;
const SIGNATURE_LENGTH = 256;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const COMPRESSION_DEFLATE_RAW = 1;

export {
  MAGIC,
  FORMAT_VERSION,
  HEADER_LENGTH,
  FLAG_SIGNED,
  SIGNATURE_LENGTH,
  SALT_LENGTH,
  NONCE_LENGTH,
  COMPRESSION_DEFLATE_RAW
};

export async function packFilterPackage({ masterKey, privateKey = null, files }) {
  const normalizedFiles = normalizeFileMap(files);
  const salt = randomBytes(SALT_LENGTH);
  const packageKey = await derivePackageKey(masterKey, salt);
  const manifestKey = await deriveNamedKey(packageKey, 'manifest-key');
  const manifestNonce = await deriveNamedNonce(packageKey, 'manifest-nonce');

  const payloadEntries = [];
  let payloadOffset = 0;

  for (const [entryId, bytes] of normalizedFiles) {
    const compressed = pako.deflateRaw(bytes);
    const nonce = randomBytes(NONCE_LENGTH);
    const entryKey = await deriveEntryKey(packageKey, entryId);
    const encrypted = await aesGcmEncrypt(entryKey, nonce, compressed);

    payloadEntries.push({
      entryId,
      originalSize: bytes.byteLength,
      encryptedSize: encrypted.byteLength,
      compression: COMPRESSION_DEFLATE_RAW,
      nonce,
      payloadOffset,
      encrypted
    });

    payloadOffset += encrypted.byteLength;
  }

  const entryListPlaintext = encodeEntryList(payloadEntries);
  const encryptedEntryList = await aesGcmEncrypt(manifestKey, manifestNonce, entryListPlaintext);

  const header = new Uint8Array(HEADER_LENGTH);
  writeHeader(header, {
    flags: privateKey ? FLAG_SIGNED : 0,
    salt,
    entryCount: payloadEntries.length,
    entryListLength: encryptedEntryList.byteLength,
    signature: new Uint8Array(SIGNATURE_LENGTH)
  });

  const payload = concatBytes([
    header,
    encryptedEntryList,
    ...payloadEntries.map((entry) => entry.encrypted)
  ]);

  if (!privateKey) {
    return payload;
  }

  const signature = await signPackage(privateKey, payload);
  writeSignature(payload, signature);
  return payload;
}

export async function unpackFilterPackage(packageBytes, { masterKey, publicKey = null, listOnly = false } = {}) {
  const bytes = toUint8Array(packageBytes);
  const header = parseHeader(bytes);
  const verification = await maybeVerifyPackage(publicKey, bytes, header);
  const packageKey = await derivePackageKey(masterKey, header.salt);
  const manifestKey = await deriveNamedKey(packageKey, 'manifest-key');
  const manifestNonce = await deriveNamedNonce(packageKey, 'manifest-nonce');
  const encryptedEntryList = bytes.slice(HEADER_LENGTH, HEADER_LENGTH + header.entryListLength);
  const entryListPlaintext = await aesGcmDecrypt(manifestKey, manifestNonce, encryptedEntryList);
  const entries = decodeEntryList(entryListPlaintext, header.entryCount);

  if (listOnly) {
    return {
      verified: verification,
      files: entries.map((entry) => ({
        path: entry.entryId,
        encryptedSize: entry.encryptedSize,
        originalSize: entry.originalSize,
        compression: entry.compression
      }))
    };
  }

  const payloadBaseOffset = HEADER_LENGTH + header.entryListLength;
  const files = {};

  for (const entry of entries) {
    const entryBytes = bytes.slice(
      payloadBaseOffset + entry.offset,
      payloadBaseOffset + entry.offset + entry.encryptedSize
    );
    const entryKey = await deriveEntryKey(packageKey, entry.entryId);
    const compressed = await aesGcmDecrypt(entryKey, entry.nonce, entryBytes);
    const originalBytes = pako.inflateRaw(compressed);
    files[entry.entryId] = decodeFileValue(entry.entryId, originalBytes);
  }

  return {
    verified: verification,
    files
  };
}

export function listFilterPackage(packageBytes) {
  const bytes = toUint8Array(packageBytes);
  const header = parseHeader(bytes);
  return {
    formatVersion: header.formatVersion,
    signed: (header.flags & FLAG_SIGNED) !== 0,
    entryCount: header.entryCount,
    entryListLength: header.entryListLength,
    salt: bytesToHex(header.salt)
  };
}

function writeHeader(target, { flags, salt, entryCount, entryListLength, signature }) {
  target.set(MAGIC, 0);
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, flags, true);
  target.set(salt, 8);
  view.setUint32(24, entryCount, true);
  view.setUint32(28, entryListLength, true);
  target.set(signature, 32);
}

function parseHeader(bytes) {
  if (bytes.byteLength < HEADER_LENGTH) {
    throw new Error('Package is shorter than the fixed header.');
  }

  const magic = bytes.slice(0, 4);
  if (!equalBytes(magic, MAGIC)) {
    throw new Error('Invalid package magic.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint16(4, true);
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(`Unsupported package format version: ${formatVersion}`);
  }

  return {
    formatVersion,
    flags: view.getUint16(6, true),
    salt: bytes.slice(8, 24),
    entryCount: view.getUint32(24, true),
    entryListLength: view.getUint32(28, true),
    signature: bytes.slice(32, 32 + SIGNATURE_LENGTH)
  };
}

function writeSignature(packageBytes, signature) {
  if (signature.byteLength !== SIGNATURE_LENGTH) {
    throw new Error(`Signature must be ${SIGNATURE_LENGTH} bytes.`);
  }
  packageBytes.set(signature, 32);
}

async function maybeVerifyPackage(publicKey, packageBytes, header) {
  const signed = (header.flags & FLAG_SIGNED) !== 0;
  if (!signed) {
    return null;
  }

  if (!publicKey) {
    return null;
  }

  return await verifyPackage(publicKey, packageBytes);
}

async function signPackage(privateKey, packageBytes) {
  const key = await importPrivateKey(privateKey);
  const signingBytes = createSigningBytes(packageBytes);
  const signature = await cryptoApi().subtle.sign({
    name: 'RSA-PSS',
    saltLength: 32
  }, key, signingBytes);
  return new Uint8Array(signature);
}

async function verifyPackage(publicKey, packageBytes) {
  const key = await importPublicKey(publicKey);
  const signingBytes = createSigningBytes(packageBytes);
  return await cryptoApi().subtle.verify({
    name: 'RSA-PSS',
    saltLength: 32
  }, key, extractSignature(packageBytes), signingBytes);
}

function createSigningBytes(packageBytes) {
  const clone = new Uint8Array(packageBytes);
  clone.fill(0, 32, 32 + SIGNATURE_LENGTH);
  return clone;
}

function extractSignature(packageBytes) {
  return packageBytes.slice(32, 32 + SIGNATURE_LENGTH);
}

async function derivePackageKey(masterKey, salt) {
  const baseKey = await importRawBytes(await normalizeSecret(masterKey), 'HKDF', ['deriveBits']);
  const bits = await cryptoApi().subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: utf8Bytes('ring.filter.package.v1')
  }, baseKey, 256);
  return new Uint8Array(bits);
}

async function deriveNamedKey(baseSecret, label) {
  const raw = await deriveNamedSecret(baseSecret, label, 256);
  return await importRawBytes(raw, 'AES-GCM', ['encrypt', 'decrypt']);
}

async function deriveNamedNonce(baseSecret, label) {
  return await deriveNamedSecret(baseSecret, label, NONCE_LENGTH * 8);
}

async function deriveEntryKey(baseSecret, entryId) {
  const raw = await deriveNamedSecret(baseSecret, `entry-key:${entryId}`, 256);
  return await importRawBytes(raw, 'AES-GCM', ['encrypt', 'decrypt']);
}

async function deriveNamedSecret(baseSecret, label, bitLength) {
  const baseKey = await importRawBytes(toUint8Array(baseSecret), 'HKDF', ['deriveBits']);
  const bits = await cryptoApi().subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: utf8Bytes(label)
  }, baseKey, bitLength);
  return new Uint8Array(bits);
}

async function aesGcmEncrypt(key, nonce, plaintext) {
  const result = await cryptoApi().subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce
  }, key, plaintext);
  return new Uint8Array(result);
}

async function aesGcmDecrypt(key, nonce, ciphertext) {
  const result = await cryptoApi().subtle.decrypt({
    name: 'AES-GCM',
    iv: nonce
  }, key, ciphertext);
  return new Uint8Array(result);
}

function encodeEntryList(entries) {
  const records = entries.map((entry) => encodeEntryRecord(entry));
  const offsetTableLength = entries.length * 4;
  const headerLength = 4 + offsetTableLength;
  const offsets = [];
  let recordOffset = 0;

  for (const record of records) {
    offsets.push(recordOffset);
    recordOffset += record.byteLength;
  }

  const totalLength = headerLength + records.reduce((sum, record) => sum + record.byteLength, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, entries.length, true);

  for (const [index, offset] of offsets.entries()) {
    view.setUint32(4 + index * 4, offset, true);
  }

  let writeOffset = headerLength;
  for (const record of records) {
    output.set(record, writeOffset);
    writeOffset += record.byteLength;
  }

  return output;
}

function decodeEntryList(bytes, expectedEntryCount) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(0, true);
  if (entryCount !== expectedEntryCount) {
    throw new Error('Entry list entry count does not match header.');
  }

  const offsets = [];
  for (let index = 0; index < entryCount; index += 1) {
    offsets.push(view.getUint32(4 + index * 4, true));
  }

  const recordsStart = 4 + entryCount * 4;
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    const nextOffset = index + 1 < entryCount ? offsets[index + 1] : (bytes.byteLength - recordsStart);
    const recordBytes = bytes.slice(recordsStart + offsets[index], recordsStart + nextOffset);
    entries.push(decodeEntryRecord(recordBytes));
  }

  return entries;
}

function encodeEntryRecord(entry) {
  const entryIdBytes = utf8Bytes(entry.entryId);
  const output = new Uint8Array(4 + entryIdBytes.byteLength + 4 + 4 + 4 + 1 + NONCE_LENGTH);
  const view = new DataView(output.buffer);
  view.setUint32(0, entryIdBytes.byteLength, true);
  output.set(entryIdBytes, 4);
  let offset = 4 + entryIdBytes.byteLength;
  view.setUint32(offset, entry.payloadOffset, true);
  offset += 4;
  view.setUint32(offset, entry.encryptedSize, true);
  offset += 4;
  view.setUint32(offset, entry.originalSize, true);
  offset += 4;
  output[offset] = entry.compression;
  offset += 1;
  output.set(entry.nonce, offset);
  return output;
}

function decodeEntryRecord(recordBytes) {
  const view = new DataView(recordBytes.buffer, recordBytes.byteOffset, recordBytes.byteLength);
  const entryIdLength = view.getUint32(0, true);
  const entryIdBytes = recordBytes.slice(4, 4 + entryIdLength);
  let offset = 4 + entryIdLength;

  return {
    entryId: utf8Text(entryIdBytes),
    offset: view.getUint32(offset, true),
    encryptedSize: view.getUint32(offset + 4, true),
    originalSize: view.getUint32(offset + 8, true),
    compression: recordBytes[offset + 12],
    nonce: recordBytes.slice(offset + 13, offset + 13 + NONCE_LENGTH)
  };
}

async function importPrivateKey(key) {
  if (isCryptoKey(key)) return key;
  return await cryptoApi().subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(String(key)),
    {
      name: 'RSA-PSS',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );
}

async function importPublicKey(key) {
  if (isCryptoKey(key)) return key;
  return await cryptoApi().subtle.importKey(
    'spki',
    pemToArrayBuffer(String(key)),
    {
      name: 'RSA-PSS',
      hash: 'SHA-256'
    },
    false,
    ['verify']
  );
}

async function importRawBytes(raw, algorithmName, usages) {
  return await cryptoApi().subtle.importKey('raw', toUint8Array(raw), { name: algorithmName }, false, usages);
}

function normalizeFileMap(files) {
  const entries = Object.entries(files ?? {}).map(([path, value]) => [normalizePath(path), normalizeFileValue(value)]);
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return entries;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function normalizeFileValue(value) {
  return typeof value === 'string' ? utf8Bytes(value) : toUint8Array(value);
}

function decodeFileValue(path, bytes) {
  return isTextPath(path) ? utf8Text(bytes) : bytes;
}

function isTextPath(path) {
  const normalized = path.toLowerCase();
  return normalized.endsWith('.json')
    || normalized.endsWith('.lua')
    || normalized.endsWith('.glsl')
    || normalized.endsWith('.md')
    || normalized.endsWith('.txt')
    || normalized.endsWith('.yaml')
    || normalized.endsWith('.yml');
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected Uint8Array-compatible value.');
}

async function normalizeSecret(secret) {
  return typeof secret === 'string' ? utf8Bytes(secret) : toUint8Array(secret);
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value));
}

function utf8Text(bytes) {
  return new TextDecoder().decode(bytes);
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

function cryptoApi() {
  const cryptoObject = globalThis.crypto?.subtle
    ? globalThis.crypto
    : globalThis.crypto?.webcrypto;
  if (!cryptoObject?.subtle) {
    throw new Error('Web Crypto API is required.');
  }
  return cryptoObject;
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atobPolyfill(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function atobPolyfill(value) {
  if (typeof atob === 'function') return atob(value);
  return Buffer.from(value, 'base64').toString('binary');
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isCryptoKey(value) {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}
