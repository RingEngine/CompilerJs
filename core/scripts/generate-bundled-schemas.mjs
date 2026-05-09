import { writeFileSync } from 'node:fs';
import { FILTER_SRC_SCHEMA_URL, FILTER_SCHEMA_URL } from '../src/schema-urls.js';

async function fetchSchema(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

const [filterSrcSchema, filterSchema] = await Promise.all([
  fetchSchema(FILTER_SRC_SCHEMA_URL),
  fetchSchema(FILTER_SCHEMA_URL),
]);

const output = `// Generated from docs schemas for runtime validation. Do not edit by hand.
export const filterSrcSchema = ${JSON.stringify(filterSrcSchema, null, 2)};

export const filterSchema = ${JSON.stringify(filterSchema, null, 2)};
`;

writeFileSync(new URL('../src/bundled-schemas.js', import.meta.url), output);
console.log('src/bundled-schemas.js updated.');
