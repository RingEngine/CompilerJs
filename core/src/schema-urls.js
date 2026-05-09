import { COMPILER_RUNTIME_VERSION } from './compiler-config.js';
export const DOCS_TAG = `runtime-${COMPILER_RUNTIME_VERSION}`;
export const DOCS_RAW_BASE_URL = `https://raw.githubusercontent.com/RingEngine/docs/${DOCS_TAG}`;
export const FILTER_SRC_SCHEMA_URL = `${DOCS_RAW_BASE_URL}/schemas/filter-src.schema.json`;
export const FILTER_SCHEMA_URL = `${DOCS_RAW_BASE_URL}/schemas/filter.schema.json`;
