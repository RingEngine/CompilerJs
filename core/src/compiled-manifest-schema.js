import Ajv2020 from 'ajv/dist/2020.js';
import { filterSchema } from './bundled-schemas.js';

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
    compiledManifestValidatorPromise = Promise.resolve(ajv.compile(filterSchema));
  }

  return await compiledManifestValidatorPromise;
}

function buildCompiledManifestSchemaErrorMessage(error) {
  const instancePath = error.instancePath || '/';
  return `compiled manifest schema validation failed at ${instancePath}: ${error.message}`;
}
