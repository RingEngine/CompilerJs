import process from 'node:process';

const tagName = String(process.env.GIT_TAG || process.argv[2] || '').trim();

if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
  throw new Error(`Invalid release tag format: "${tagName}". Expected v0.0.0.`);
}

console.log(JSON.stringify({ ok: true, tag: tagName, version: tagName.slice(1) }, null, 2));
