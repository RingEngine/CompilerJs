import Ajv2020 from 'ajv/dist/2020.js';
import { FILTER_SCHEMA_URL } from './schema-urls.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});

let compiledManifestValidatorPromise = null;

export async function validateCompiledManifestAgainstSchema(manifest) {
  const validateCompiledManifest = await getCompiledManifestValidator();
  const ok = validateCompiledManifest(manifest);
  if (ok) return [];

  return (validateCompiledManifest.errors ?? []).map((error) => ({
    severity: 'error',
    code: 'compiled_manifest_schema_error',
    message: buildCompiledManifestSchemaErrorMessage(error),
    path: 'manifest.json'
  }));
}

async function getCompiledManifestValidator() {
  if (!compiledManifestValidatorPromise) {
    compiledManifestValidatorPromise = loadCompiledManifestSchema()
      .then((schema) => ajv.compile(schema))
      .catch((error) => {
        compiledManifestValidatorPromise = null;
        throw error;
      });
  }

  return await compiledManifestValidatorPromise;
}

async function loadCompiledManifestSchema() {
  const response = await fetch(FILTER_SCHEMA_URL, {
    headers: {
      accept: 'application/schema+json, application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load compiled manifest schema from ${FILTER_SCHEMA_URL}: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

function buildCompiledManifestSchemaErrorMessage(error) {
  const instancePath = error.instancePath || '/';
  return `compiled manifest schema validation failed at ${instancePath}: ${error.message}`;
}
