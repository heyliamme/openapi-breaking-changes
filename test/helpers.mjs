import { createRequire } from 'module';
import { stringify } from 'yaml';

export const core = createRequire(import.meta.url)('../dist/core.js');

/** Every id any test produced, to check that every documented rule is exercised. */
export const produced = new Set();
/** Every change any test produced, to check levels against the catalog. */
export const levelChecks = [];

/** Compares two specs given as objects (YAML text by default) or strings. */
export async function diff(a, b, { files = {}, json = false } = {}) {
  const text = (x) => (typeof x === 'string' ? x : json ? JSON.stringify(x, null, 2) : stringify(x));
  const read = async (p) => (p in files ? text(files[p]) : undefined);
  const r = await core.compare({ text: text(a), path: '/api/old/spec.yaml', read: (p) => read(p.replace('/api/old/', '/api/')) }, { text: text(b), path: '/api/new/spec.yaml', read: (p) => read(p.replace('/api/new/', '/api/')) });
  for (const c of r.changes) {
    produced.add(c.id);
    levelChecks.push(c);
  }
  return r;
}

export const ids = (r) => r.changes.map((c) => `${c.level}:${c.id}`);
export const only = (r, id) => r.changes.filter((c) => c.id === id);

export const spec = (paths, extra = {}) => ({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths, ...extra });
export const spec31 = (paths, extra = {}) => ({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths, ...extra });
export const swagger = (paths, extra = {}) => ({ swagger: '2.0', info: { title: 'T', version: '1' }, paths, ...extra });

export const ok = { 200: { description: 'ok' } };

/** A spec with POST /x taking `schema` as its JSON request body. */
export const withRequest = (schema, extra = {}) => spec({ '/x': { post: { requestBody: { required: true, content: { 'application/json': { schema } } }, responses: ok } } }, extra);

/** A spec with GET /x returning `schema` as JSON. */
export const withResponse = (schema, extra = {}) => spec({ '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } } } } }, extra);

/** A spec with GET /x taking `param` as a parameter. */
export const withParam = (...params) => spec({ '/x': { get: { parameters: params, responses: ok } } });

/** Request and response comparisons of the same pair of schemas. */
export async function both(a, b, extra) {
  const req = await diff(withRequest(a, extra), withRequest(b, extra));
  const res = await diff(withResponse(a, extra), withResponse(b, extra));
  return { req: ids(req), res: ids(res), reqR: req, resR: res };
}
