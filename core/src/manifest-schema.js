import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseJsonWithPointers } from 'json-source-map';
import { FILTER_SRC_SCHEMA_URL } from './schema-urls.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});

let filterSrcSchemaValidatorPromise = null;

export function parseManifestWithPointers(source) {
  const result = parseJsonWithPointers(source);
  return {
    manifest: result.data,
    pointers: result.pointers
  };
}

export async function validateManifestAgainstSchema(manifest, pointers) {
  const validateFilterSrcManifest = await getFilterSrcSchemaValidator();
  const ok = validateFilterSrcManifest(manifest);
  if (ok) return [];

  const errors = simplifyManifestSchemaErrors(validateFilterSrcManifest.errors ?? [], manifest);
  return errors.map((error) => {
    const location = getSchemaErrorLocation(error, pointers);
    return {
      severity: 'error',
      code: 'manifest_schema_error',
      message: buildSchemaErrorMessage(error),
      path: 'manifest.json',
      line: location?.line,
      column: location?.column
    };
  });
}

async function getFilterSrcSchemaValidator() {
  if (!filterSrcSchemaValidatorPromise) {
    filterSrcSchemaValidatorPromise = loadFilterSrcSchema()
      .then((schema) => ajv.compile(schema))
      .catch((error) => {
        filterSrcSchemaValidatorPromise = null;
        throw error;
      });
  }

  return await filterSrcSchemaValidatorPromise;
}

async function loadFilterSrcSchema() {
  const response = await fetch(FILTER_SRC_SCHEMA_URL, {
    headers: {
      accept: 'application/schema+json, application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load filter-src schema from ${FILTER_SRC_SCHEMA_URL}: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

function buildSchemaErrorMessage(error) {
  if (error.keyword === 'invalidPassType') {
    const actual = JSON.stringify(error.params.actual);
    const expected = error.params.allowedValues.map((value) => JSON.stringify(value)).join(' or ');
    return `manifest.json schema validation failed at ${error.instancePath}: invalid pass type ${actual}; expected ${expected}`;
  }

  const instancePath = error.instancePath || '/';
  return `manifest.json schema validation failed at ${instancePath}: ${error.message}`;
}

function simplifyManifestSchemaErrors(errors, manifest) {
  const invalidPassTypeErrors = [];
  const invalidPassPointers = new Set();

  for (const error of errors) {
    const passPointer = getPassPointerFromOneOfError(error);
    if (!passPointer) continue;

    const actualType = getValueByPointer(manifest, `${passPointer}/type`);
    if (actualType === undefined || actualType === 'render' || actualType === 'compute') continue;

    invalidPassPointers.add(passPointer);
    invalidPassTypeErrors.push({
      keyword: 'invalidPassType',
      instancePath: `${passPointer}/type`,
      message: 'invalid pass type',
      params: {
        actual: actualType,
        allowedValues: ['render', 'compute']
      }
    });
  }

  if (invalidPassTypeErrors.length === 0) return errors;

  const noisyKeywords = new Set(['required', 'additionalProperties', 'const', 'oneOf']);
  const filteredErrors = errors.filter((error) => {
    const passPointer = getPassPointer(error.instancePath || '');
    if (!passPointer || !invalidPassPointers.has(passPointer)) return true;
    return !noisyKeywords.has(error.keyword);
  });

  return [...invalidPassTypeErrors, ...filteredErrors];
}

function getPassPointerFromOneOfError(error) {
  if (error.keyword !== 'oneOf') return '';
  return getPassPointer(error.instancePath || '');
}

function getPassPointer(pointer) {
  const match = String(pointer).match(/^\/passes\/\d+(?=\/|$)/);
  return match ? match[0] : '';
}

function getValueByPointer(value, pointer) {
  if (!pointer) return value;

  let current = value;
  for (const rawPart of pointer.split('/').slice(1)) {
    if (current == null) return undefined;
    const part = unescapeJsonPointerToken(rawPart);
    current = current[part];
  }
  return current;
}

function getSchemaErrorLocation(error, pointers) {
  const pointer = getRelevantInstancePointer(error);
  const entry = pointers[pointer];

  if (entry?.key) return entry.key;
  if (entry?.value) return entry.value;

  const parentPointer = getParentPointer(pointer);
  const parentEntry = pointers[parentPointer];
  if (parentEntry?.value) return parentEntry.value;

  return pointers['']?.value ?? null;
}

function getRelevantInstancePointer(error) {
  const basePointer = error.instancePath || '';

  if (error.keyword === 'required') {
    return `${basePointer}/${escapeJsonPointerToken(error.params.missingProperty)}`;
  }

  if (error.keyword === 'additionalProperties') {
    return `${basePointer}/${escapeJsonPointerToken(error.params.additionalProperty)}`;
  }

  return basePointer;
}

function getParentPointer(pointer) {
  if (!pointer) return '';
  const lastSlash = pointer.lastIndexOf('/');
  return lastSlash <= 0 ? '' : pointer.slice(0, lastSlash);
}

function escapeJsonPointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeJsonPointerToken(token) {
  return String(token).replace(/~1/g, '/').replace(/~0/g, '~');
}
