const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

export function createZipArchive(files) {
  const entries = normalizeFileEntries(files);
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const localHeader = buildLocalHeader(entry);
    const centralHeader = buildCentralHeader(entry, localOffset);
    localChunks.push(localHeader, entry.bytes);
    centralChunks.push(centralHeader);
    localOffset += localHeader.byteLength + entry.bytes.byteLength;
  }

  const centralDirectory = concatBytes(centralChunks);
  const endOfCentralDirectory = buildEndOfCentralDirectory(entries.length, centralDirectory.byteLength, localOffset);
  return concatBytes([...localChunks, centralDirectory, endOfCentralDirectory]);
}

export function readZipArchive(zipBytes) {
  const bytes = toUint8Array(zipBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let offset = 0;

  while (offset + 4 <= bytes.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
      break;
    }

    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const method = view.getUint16(offset + 8, true);
    if (method !== 0) {
      throw new Error('This ZIP reader only supports stored entries.');
    }

    const fileName = utf8Text(bytes.slice(offset + 30, offset + 30 + fileNameLength));
    const dataOffset = offset + 30 + fileNameLength + extraLength;
    const data = bytes.slice(dataOffset, dataOffset + compressedSize);
    files[fileName] = isTextPath(fileName) ? utf8Text(data) : data;
    offset = dataOffset + compressedSize;
  }

  return files;
}

function normalizeFileEntries(files) {
  return Object.entries(files)
    .map(([path, value]) => {
      const normalizedPath = String(path).replace(/\\/g, '/').replace(/^\.\/+/, '');
      const bytes = typeof value === 'string' ? utf8Bytes(value) : toUint8Array(value);
      return {
        path: normalizedPath,
        bytes,
        crc32: crc32(bytes)
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildLocalHeader(entry) {
  const fileNameBytes = utf8Bytes(entry.path);
  const output = new Uint8Array(30 + fileNameBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, entry.crc32 >>> 0, true);
  view.setUint32(18, entry.bytes.byteLength, true);
  view.setUint32(22, entry.bytes.byteLength, true);
  view.setUint16(26, fileNameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  output.set(fileNameBytes, 30);
  return output;
}

function buildCentralHeader(entry, localOffset) {
  const fileNameBytes = utf8Bytes(entry.path);
  const output = new Uint8Array(46 + fileNameBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, entry.crc32 >>> 0, true);
  view.setUint32(20, entry.bytes.byteLength, true);
  view.setUint32(24, entry.bytes.byteLength, true);
  view.setUint16(28, fileNameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  output.set(fileNameBytes, 46);
  return output;
}

function buildEndOfCentralDirectory(entryCount, centralDirectoryLength, centralDirectoryOffset) {
  const output = new Uint8Array(22);
  const view = new DataView(output.buffer);
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectoryLength, true);
  view.setUint32(16, centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
  return output;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value ^ 0xffffffff;
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

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value));
}

function utf8Text(bytes) {
  return new TextDecoder().decode(bytes);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected Uint8Array-compatible value.');
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

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});
