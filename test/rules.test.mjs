// Every rule, from both directions where it applies. The last test checks that every id
// in the catalog came up somewhere in this file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { both, core, diff, ids, levelChecks, ok, only, produced, spec, spec31, swagger, withParam, withRequest, withResponse } from './helpers.mjs';

const obj = (properties, required = []) => ({ type: 'object', required, properties });
const str = { type: 'string' };
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

// --- endpoints ---------------------------------------------------------------------------

test('endpoint removed, added, deprecated, reactivated', async () => {
  const a = spec({ '/a': { get: { responses: ok }, post: { responses: ok } }, '/b': { get: { deprecated: true, responses: ok } } });
  const b = spec({ '/a': { get: { deprecated: true, responses: ok } }, '/b': { get: { responses: ok } }, '/c': { put: { responses: ok } } });
  const r = await diff(a, b);
  assert.deepEqual(ids(r).sort(), ['error:endpoint-removed', 'info:endpoint-added', 'info:endpoint-deprecated', 'info:endpoint-reactivated'].sort());
  const removed = only(r, 'endpoint-removed')[0];
  assert.equal(removed.method, 'POST');
  assert.equal(removed.path, '/a');
  assert.equal(only(r, 'endpoint-added')[0].method, 'PUT');
});

test('removing a deprecated endpoint is a warning', async () => {
  const r = await diff(spec({ '/a': { get: { deprecated: true, responses: ok } } }), spec({}));
  assert.deepEqual(ids(r), ['warning:deprecated-endpoint-removed']);
});

test('renaming a path parameter is not a change', async () => {
  const a = spec({ '/pets/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: str }], responses: ok } } });
  const b = spec({ '/pets/{petId}': { get: { parameters: [{ name: 'petId', in: 'path', required: true, schema: str }], responses: ok } } });
  assert.deepEqual(ids(await diff(a, b)), []);
});

test('the endpoint is named by its new path', async () => {
  const a = spec({ '/pets/{id}': { get: { operationId: 'a', responses: ok } } });
  const b = spec({ '/pets/{petId}': { get: { operationId: 'b', responses: ok } } });
  const [c] = (await diff(a, b)).changes;
  assert.equal(c.path, '/pets/{petId}');
});

test('operationId changed or removed', async () => {
  const a = spec({ '/a': { get: { operationId: 'getA', responses: ok } }, '/b': { get: { operationId: 'getB', responses: ok } } });
  const b = spec({ '/a': { get: { operationId: 'fetchA', responses: ok } }, '/b': { get: { responses: ok } } });
  const r = await diff(a, b);
  assert.deepEqual(ids(r), ['warning:operation-id-changed', 'warning:operation-id-changed']);
  assert.match(r.changes[1].message, /removed/);
  // Adding one where there was none is not reported.
  assert.deepEqual(ids(await diff(b, a)).filter((x) => x.includes('operation-id')), ['warning:operation-id-changed']);
});

test('x- keys under paths are not endpoints', async () => {
  const r = await diff(spec({ 'x-internal': { foo: 1 } }), spec({ 'x-internal': { foo: 2 } }));
  assert.deepEqual(ids(r), []);
});

// --- parameters --------------------------------------------------------------------------

test('parameter added: optional is info, required is an error', async () => {
  const r = await diff(withParam(), withParam({ name: 'a', in: 'query', schema: str }, { name: 'b', in: 'header', required: true, schema: str }));
  assert.deepEqual(ids(r), ['info:request-parameter-added', 'error:request-parameter-added-required']);
});

test('parameter removed is a warning', async () => {
  const r = await diff(withParam({ name: 'a', in: 'query', schema: str }), withParam());
  assert.deepEqual(ids(r), ['warning:request-parameter-removed']);
});

test('parameter moved from query to header', async () => {
  const r = await diff(withParam({ name: 'tenant', in: 'query', schema: str }), withParam({ name: 'tenant', in: 'header', schema: str }));
  assert.deepEqual(ids(r), ['error:request-parameter-location-changed']);
  assert.match(r.changes[0].message, /from query to header/);
});

test('header parameter names are case-insensitive', async () => {
  const r = await diff(withParam({ name: 'X-Trace', in: 'header', schema: str }), withParam({ name: 'x-trace', in: 'header', schema: str }));
  assert.deepEqual(ids(r), []);
});

test('parameter became required / optional', async () => {
  const p = (required) => withParam({ name: 'a', in: 'query', required, schema: str });
  assert.deepEqual(ids(await diff(p(false), p(true))), ['error:request-parameter-became-required']);
  assert.deepEqual(ids(await diff(p(true), p(false))), ['info:request-parameter-became-optional']);
});

test('parameter deprecated', async () => {
  const r = await diff(withParam({ name: 'a', in: 'query', schema: str }), withParam({ name: 'a', in: 'query', deprecated: true, schema: str }));
  assert.deepEqual(ids(r), ['info:request-parameter-deprecated']);
});

test('parameter serialization changed', async () => {
  const r = await diff(withParam({ name: 'a', in: 'query', schema: { type: 'array', items: str } }), withParam({ name: 'a', in: 'query', explode: false, schema: { type: 'array', items: str } }));
  assert.deepEqual(ids(r), ['warning:request-parameter-serialization-changed']);
  // Writing the default out is not a change.
  assert.deepEqual(ids(await diff(withParam({ name: 'a', in: 'query', schema: str }), withParam({ name: 'a', in: 'query', style: 'form', explode: true, schema: str }))), []);
});

test('path-level parameters apply, and operation-level ones override them', async () => {
  const a = spec({ '/x': { parameters: [{ name: 'a', in: 'query', schema: str }], get: { responses: ok } } });
  const b = spec({ '/x': { parameters: [{ name: 'a', in: 'query', schema: str }], get: { parameters: [{ name: 'a', in: 'query', required: true, schema: str }], responses: ok } } });
  assert.deepEqual(ids(await diff(a, b)), ['error:request-parameter-became-required']);
});

test('parameter schema rules use the request-parameter prefix', async () => {
  const p = (schema) => withParam({ name: 'limit', in: 'query', schema });
  const r = await diff(p({ type: 'integer', maximum: 100, enum: [1, 2, 3] }), p({ type: 'string', maximum: 50 }));
  assert.deepEqual(ids(r), ['error:request-parameter-type-changed']);
  const r2 = await diff(p({ type: 'integer', maximum: 100, default: 10, enum: [10, 20] }), p({ type: 'integer', maximum: 50, default: 20, enum: [20, 30] }));
  assert.deepEqual(ids(r2).sort(), ['error:request-parameter-enum-value-removed', 'info:request-parameter-enum-value-added', 'error:request-parameter-max-decreased', 'warning:request-parameter-default-changed'].sort());
  assert.match(only(r2, 'request-parameter-max-decreased')[0].message, /^Query parameter `limit`: maximum changed from 100 to 50$/);
});

test('parameters described with content instead of schema', async () => {
  const p = (type) => withParam({ name: 'filter', in: 'query', content: { 'application/json': { schema: { type } } } });
  assert.deepEqual(ids(await diff(p('object'), p('string'))), ['error:request-parameter-type-changed']);
});

// --- request body ------------------------------------------------------------------------

const body = (rb) => spec({ '/x': { post: { ...(rb ? { requestBody: rb } : {}), responses: ok } } });
const json = (schema = str) => ({ 'application/json': { schema } });

test('request body added, removed, required and optional', async () => {
  assert.deepEqual(ids(await diff(body(), body({ content: json() }))), ['info:request-body-added']);
  assert.deepEqual(ids(await diff(body(), body({ required: true, content: json() }))), ['error:request-body-added-required']);
  assert.deepEqual(ids(await diff(body({ content: json() }), body())), ['warning:request-body-removed']);
  assert.deepEqual(ids(await diff(body({ content: json() }), body({ required: true, content: json() }))), ['error:request-body-became-required']);
  assert.deepEqual(ids(await diff(body({ required: true, content: json() }), body({ content: json() }))), ['info:request-body-became-optional']);
});

test('request media types added and removed', async () => {
  const r = await diff(body({ content: { ...json(), 'application/xml': { schema: str } } }), body({ content: { ...json(), 'text/csv': { schema: str } } }));
  assert.deepEqual(ids(r), ['error:request-body-media-type-removed', 'info:request-body-media-type-added']);
});

test('media types with parameters pair with the plain one', async () => {
  const r = await diff(body({ content: json({ type: 'integer' }) }), body({ content: { 'application/json; charset=utf-8': { schema: str } } }));
  assert.deepEqual(ids(r), ['error:request-body-type-changed']);
});

test('a media range pairs with the types it covers', async () => {
  const res = (responses) => spec({ '/x': { get: { responses } } });
  const props = (required, properties) => ({ type: 'object', required, properties });
  // `application/json` → `*/*`: JSON is still accepted, and the schemas are compared.
  let r = await diff(body({ content: json(props([], { a: str })) }), body({ content: { '*/*': { schema: props(['b'], { a: str, b: str }) } } }));
  assert.deepEqual(ids(r), ['error:request-property-added-required']);
  // `*/*` → `application/json`: other types are no longer accepted.
  r = await diff(body({ content: { '*/*': { schema: str } } }), body({ content: json() }));
  assert.deepEqual(ids(r), ['error:request-body-media-type-removed']);
  assert.match(r.changes[0].message, /narrowed to `application\/json`/);
  // Responses: `*/*` → `application/json` narrows what clients get; the schemas still count.
  r = await diff(res({ 200: { description: 'ok', content: { '*/*': { schema: props(['id'], { id: str, n: str }) } } } }), res({ 200: { description: 'ok', content: json(props([], { n: str })) } }));
  assert.deepEqual(ids(r), ['error:response-property-removed']);
  r = await diff(res({ 200: { description: 'ok', content: json() } }), res({ 200: { description: 'ok', content: { 'application/*': { schema: str } } } }));
  assert.deepEqual(ids(r), ['info:response-media-type-added']);
});

test('a requestBody $ref is followed', async () => {
  const comp = (required) => ({ components: { requestBodies: { Pet: { required, content: json(obj({ name: str })) } } } });
  const a = spec({ '/x': { post: { requestBody: { $ref: '#/components/requestBodies/Pet' }, responses: ok } } }, comp(false));
  const b = spec({ '/x': { post: { requestBody: { $ref: '#/components/requestBodies/Pet' }, responses: ok } } }, comp(true));
  assert.deepEqual(ids(await diff(a, b)), ['error:request-body-became-required']);
});

// --- responses ---------------------------------------------------------------------------

const resp = (responses) => spec({ '/x': { get: { responses } } });

test('response status removed: 2xx is an error, others a warning', async () => {
  const r = await diff(resp({ 200: { description: 'ok' }, 404: { description: 'no' }, default: { description: 'e' } }), resp({ 201: { description: 'ok' } }));
  assert.deepEqual(ids(r), ['error:response-success-status-removed', 'warning:response-status-removed', 'warning:response-status-removed', 'info:response-status-added']);
});

test('status codes compare case-insensitively (2XX)', async () => {
  assert.deepEqual(ids(await diff(resp({ '2XX': { description: 'ok' } }), resp({ '2xx': { description: 'ok' } }))), []);
});

test('a status range covers the codes in it', async () => {
  const schema = (type) => ({ description: 'ok', content: json({ type }) });
  assert.deepEqual(ids(await diff(resp({ 200: schema('object') }), resp({ '2XX': schema('array') }))), ['error:response-body-type-changed']);
  assert.deepEqual(ids(await diff(resp({ '2XX': schema('object') }), resp({ 200: schema('object') }))), []);
  assert.deepEqual(ids(await diff(resp({ 404: { description: 'no' } }), resp({ '4XX': { description: 'no' } }))), []);
});

test('response media types added and removed', async () => {
  const r = await diff(resp({ 200: { description: 'ok', content: { ...json(), 'application/xml': { schema: str } } } }), resp({ 200: { description: 'ok', content: { ...json(), 'text/plain': { schema: str } } } }));
  assert.deepEqual(ids(r), ['error:response-media-type-removed', 'info:response-media-type-added']);
});

test('response headers', async () => {
  const h = (headers) => resp({ 200: { description: 'ok', headers } });
  const r = await diff(h({ 'X-Rate': { required: true, schema: { type: 'integer' } }, 'X-Old': { schema: str }, 'X-Req': { required: true, schema: str } }), h({ 'x-rate': { schema: { type: 'string' } }, 'X-New': { schema: str } }));
  assert.deepEqual(ids(r).sort(), ['error:response-header-became-optional', 'error:response-header-type-changed', 'warning:response-header-removed', 'error:response-header-removed', 'info:response-header-added'].sort());
  assert.match(only(r, 'response-header-type-changed')[0].message, /^Header `x-rate` of the 200 response: type changed from `integer` to `string`$/);
});

test('a response $ref is followed', async () => {
  const comp = (type) => ({ components: { responses: { Pet: { description: 'ok', content: json({ type }) } } } });
  const a = spec({ '/x': { get: { responses: { 200: { $ref: '#/components/responses/Pet' } } } } }, comp('string'));
  const b = spec({ '/x': { get: { responses: { 200: { $ref: '#/components/responses/Pet' } } } } }, comp('integer'));
  assert.deepEqual(ids(await diff(a, b)), ['error:response-body-type-changed']);
});

// --- schemas -----------------------------------------------------------------------------

test('type changed', async () => {
  const { req, res } = await both(str, { type: 'integer' });
  assert.deepEqual(req, ['error:request-body-type-changed']);
  assert.deepEqual(res, ['error:response-body-type-changed']);
});

test('integer to number widens requests and breaks responses', async () => {
  const { req, res } = await both({ type: 'integer' }, { type: 'number' });
  assert.deepEqual(req, ['info:request-body-type-changed']);
  assert.deepEqual(res, ['error:response-body-type-changed']);
  const back = await both({ type: 'number' }, { type: 'integer' });
  assert.deepEqual(back.req, ['error:request-body-type-changed']);
  assert.deepEqual(back.res, ['info:response-body-type-changed']);
});

test('3.1 type arrays: adding a type widens', async () => {
  const { req, res } = await both({ type: 'string' }, { type: ['string', 'integer'] });
  assert.deepEqual(req, ['info:request-body-type-changed']);
  assert.deepEqual(res, ['error:response-body-type-changed']);
});

test('unrelated types stop the comparison there', async () => {
  const { req } = await both(obj({ a: str }), { type: 'array', items: str });
  assert.deepEqual(req, ['error:request-body-type-changed']);
});

test('adding `type: object` next to properties is not a change', async () => {
  const { req, res } = await both({ properties: { a: str } }, { type: 'object', properties: { a: str } });
  assert.deepEqual([...req, ...res], []);
});

test('nullable: 3.0 nullable, 3.1 type null, 2.0 x-nullable', async () => {
  const a = await both(str, { type: 'string', nullable: true });
  assert.deepEqual(a.req, ['info:request-body-became-nullable']);
  assert.deepEqual(a.res, ['warning:response-body-became-nullable']);
  const b = await both({ type: ['string', 'null'] }, str);
  assert.deepEqual(b.req, ['error:request-body-became-not-nullable']);
  assert.deepEqual(b.res, ['info:response-body-became-not-nullable']);
  // The same thing written the 3.0 way and the 3.1 way.
  const c = await both({ type: 'string', nullable: true }, { type: ['string', 'null'] });
  assert.deepEqual([...c.req, ...c.res], []);
  const d = await both({ type: 'string', 'x-nullable': true }, { type: 'string', nullable: true });
  assert.deepEqual([...d.req, ...d.res], []);
});

test('format: widened, narrowed, added, removed, changed', async () => {
  const f = (format) => ({ type: 'integer', ...(format ? { format } : {}) });
  const widen = await both(f('int32'), f('int64'));
  assert.deepEqual(widen.req, ['info:request-body-format-changed']);
  assert.deepEqual(widen.res, ['warning:response-body-format-changed']);
  const narrow = await both(f('int64'), f('int32'));
  assert.deepEqual(narrow.req, ['error:request-body-format-changed']);
  assert.deepEqual(narrow.res, ['info:response-body-format-changed']);
  const added = await both(str, { type: 'string', format: 'email' });
  assert.deepEqual(added.req, ['warning:request-body-format-changed']);
  assert.deepEqual(added.res, ['info:response-body-format-changed']);
  const removed = await both({ type: 'string', format: 'uuid' }, str);
  assert.deepEqual(removed.req, ['info:request-body-format-changed']);
  assert.deepEqual(removed.res, ['warning:response-body-format-changed']);
  const changed = await both({ type: 'string', format: 'date' }, { type: 'string', format: 'date-time' });
  assert.deepEqual(changed.req, ['error:request-body-format-changed']);
  assert.deepEqual(changed.res, ['error:response-body-format-changed']);
});

test('enum values added and removed', async () => {
  const { req, res, reqR } = await both({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['b', 'c'] });
  assert.deepEqual(req, ['error:request-body-enum-value-removed', 'info:request-body-enum-value-added']);
  assert.deepEqual(res, ['info:response-body-enum-value-removed', 'warning:response-body-enum-value-added']);
  assert.match(reqR.changes[0].message, /enum value `a` removed/);
});

test('enum added and dropped; const counts as a one-value enum', async () => {
  const a = await both(str, { type: 'string', enum: ['x'] });
  assert.deepEqual(a.req, ['error:request-body-became-enum']);
  assert.deepEqual(a.res, ['info:response-body-became-enum']);
  const b = await both({ type: 'string', const: 'x' }, str);
  assert.deepEqual(b.req, ['info:request-body-no-longer-enum']);
  assert.deepEqual(b.res, ['warning:response-body-no-longer-enum']);
  const c = await both({ type: 'string', const: 'x' }, { type: 'string', enum: ['x'] });
  assert.deepEqual([...c.req, ...c.res], []);
});

test('null in an enum is nullability, not an enum value', async () => {
  const { req, res } = await both({ type: 'string', nullable: true, enum: ['a', null] }, { type: 'string', nullable: true, enum: ['a'] });
  assert.deepEqual([...req, ...res], []);
});

test('numeric bounds, both ways, exclusive forms', async () => {
  const n = (x) => ({ type: 'number', ...x });
  let r = await both(n({ maximum: 10 }), n({ maximum: 5 }));
  assert.deepEqual(r.req, ['error:request-body-max-decreased']);
  assert.deepEqual(r.res, ['info:response-body-max-decreased']);
  r = await both(n({ maximum: 5 }), n({}));
  assert.deepEqual(r.req, ['info:request-body-max-increased']);
  assert.deepEqual(r.res, ['info:response-body-max-increased']);
  r = await both(n({ minimum: 0 }), n({ minimum: 1 }));
  assert.deepEqual(r.req, ['error:request-body-min-increased']);
  r = await both(n({ minimum: 1 }), n({ minimum: 0 }));
  assert.deepEqual(r.req, ['info:request-body-min-decreased']);
  // 3.0 boolean exclusiveMaximum vs 3.1 numeric: the same bound.
  r = await both(n({ maximum: 10, exclusiveMaximum: true }), n({ exclusiveMaximum: 10 }));
  assert.deepEqual([...r.req, ...r.res], []);
  r = await both(n({ maximum: 10 }), n({ maximum: 10, exclusiveMaximum: true }));
  assert.deepEqual(r.req, ['error:request-body-max-decreased']);
  r = await both(n({}), n({ minimum: 0, exclusiveMinimum: true }));
  assert.deepEqual(r.req, ['error:request-body-min-increased']);
});

test('length and item counts', async () => {
  const cases = [
    [{ maxLength: 10 }, { maxLength: 5 }, 'error:request-body-max-length-decreased', 'info:response-body-max-length-decreased'],
    [{ maxLength: 5 }, {}, 'info:request-body-max-length-increased', 'info:response-body-max-length-increased'],
    [{}, { minLength: 2 }, 'error:request-body-min-length-increased', 'info:response-body-min-length-increased'],
    [{ minLength: 2 }, { minLength: 1 }, 'info:request-body-min-length-decreased', 'info:response-body-min-length-decreased'],
  ];
  for (const [a, b, rq, rs] of cases) {
    const r = await both({ type: 'string', ...a }, { type: 'string', ...b });
    assert.deepEqual(r.req, [rq], JSON.stringify([a, b]));
    assert.deepEqual(r.res, [rs], JSON.stringify([a, b]));
  }
  const arr = (x) => ({ type: 'array', items: str, ...x });
  const items = [
    [{ maxItems: 10 }, { maxItems: 3 }, 'error:request-body-max-items-decreased', 'info:response-body-max-items-decreased'],
    [{ maxItems: 3 }, { maxItems: 10 }, 'info:request-body-max-items-increased', 'info:response-body-max-items-increased'],
    [{}, { minItems: 1 }, 'error:request-body-min-items-increased', 'info:response-body-min-items-increased'],
    [{ minItems: 2 }, {}, 'info:request-body-min-items-decreased', 'info:response-body-min-items-decreased'],
  ];
  for (const [a, b, rq, rs] of items) {
    const r = await both(arr(a), arr(b));
    assert.deepEqual(r.req, [rq], JSON.stringify([a, b]));
    assert.deepEqual(r.res, [rs], JSON.stringify([a, b]));
  }
  // minLength: 0 is the same as none.
  const z = await both({ type: 'string', minLength: 0 }, str);
  assert.deepEqual([...z.req, ...z.res], []);
});

test('property counts, multipleOf and uniqueItems', async () => {
  const o = (x) => ({ type: 'object', ...x });
  const n = (x) => ({ type: 'number', ...x });
  const arr = (x) => ({ type: 'array', items: str, ...x });
  const cases = [
    [o({ maxProperties: 5 }), o({ maxProperties: 1 }), 'error:request-body-max-properties-decreased', 'info:response-body-max-properties-decreased'],
    [o({ maxProperties: 1 }), o({}), 'info:request-body-max-properties-increased', 'info:response-body-max-properties-increased'],
    [o({}), o({ minProperties: 1 }), 'error:request-body-min-properties-increased', 'info:response-body-min-properties-increased'],
    [o({ minProperties: 2 }), o({ minProperties: 1 }), 'info:request-body-min-properties-decreased', 'info:response-body-min-properties-decreased'],
    [n({}), n({ multipleOf: 5 }), 'error:request-body-multiple-of-changed', 'info:response-body-multiple-of-changed'],
    // 10, 20, 30… are all multiples of 5: nothing a client sent is refused.
    [n({ multipleOf: 10 }), n({ multipleOf: 5 }), 'info:request-body-multiple-of-changed', 'info:response-body-multiple-of-changed'],
    [n({ multipleOf: 0.3 }), n({ multipleOf: 0.1 }), 'info:request-body-multiple-of-changed', 'info:response-body-multiple-of-changed'],
    [n({ multipleOf: 0.5 }), n({ multipleOf: 0.2 }), 'error:request-body-multiple-of-changed', 'info:response-body-multiple-of-changed'],
    [n({ multipleOf: 5 }), n({}), 'info:request-body-multiple-of-changed', 'info:response-body-multiple-of-changed'],
    [arr({}), arr({ uniqueItems: true }), 'error:request-body-unique-items-added', 'info:response-body-unique-items-added'],
    [arr({ uniqueItems: true }), arr({ uniqueItems: false }), 'info:request-body-unique-items-removed', 'info:response-body-unique-items-removed'],
  ];
  for (const [a, b, rq, rs] of cases) {
    const r = await both(a, b);
    assert.deepEqual(r.req, [rq], JSON.stringify([a, b]));
    assert.deepEqual(r.res, [rs], JSON.stringify([a, b]));
  }
  // The same on a property.
  const r = await diff(withRequest(obj({ tags: arr({}) })), withRequest(obj({ tags: arr({ uniqueItems: true, maxItems: 3 }) })));
  assert.deepEqual(ids(r).sort(), ['error:request-property-max-items-decreased', 'error:request-property-unique-items-added']);
});

test('a request object that rejects unlisted properties: removing one breaks', async () => {
  const closed = (props) => ({ ...obj(props), additionalProperties: false });
  const r = await diff(withRequest(closed({ a: str, b: str })), withRequest(closed({ a: str })));
  assert.deepEqual(ids(r), ['error:request-property-removed']);
  assert.match(r.changes[0].message, /unlisted properties are rejected/);
  // An open object still accepts it.
  assert.deepEqual(ids(await diff(withRequest(obj({ a: str, b: str })), withRequest(obj({ a: str })))), ['warning:request-property-removed']);
  // A typed map closed off.
  const map = (ap) => ({ type: 'object', additionalProperties: ap });
  assert.deepEqual(ids(await diff(withRequest(map(str)), withRequest(map(false)))), ['error:request-body-additional-properties-restricted']);
  assert.deepEqual(ids(await diff(withResponse(map(str)), withResponse(map(false)))), []);
});

test('pattern added, changed, removed', async () => {
  let r = await both(str, { type: 'string', pattern: '^a' });
  assert.deepEqual(r.req, ['warning:request-body-pattern-added']);
  assert.deepEqual(r.res, ['info:response-body-pattern-added']);
  r = await both({ type: 'string', pattern: '^a' }, { type: 'string', pattern: '^b' });
  assert.deepEqual(r.req, ['warning:request-body-pattern-changed']);
  assert.deepEqual(r.res, ['info:response-body-pattern-changed']);
  r = await both({ type: 'string', pattern: '^a' }, str);
  assert.deepEqual(r.req, ['info:request-body-pattern-removed']);
  assert.deepEqual(r.res, ['info:response-body-pattern-removed']);
});

test('default changed matters for requests only', async () => {
  const r = await both({ type: 'string', default: 'a' }, { type: 'string', default: 'b' });
  assert.deepEqual(r.req, ['warning:request-body-default-changed']);
  assert.deepEqual(r.res, []);
});

test('properties removed', async () => {
  const r = await both(obj({ a: str, b: str }, ['a']), obj({}));
  assert.deepEqual(r.req, ['warning:request-property-removed', 'warning:request-property-removed']);
  assert.deepEqual(r.res, ['error:response-property-removed', 'warning:response-property-removed']);
  assert.match(r.resR.changes[0].message, /^Response property `a` was removed \(it was required\) \(200 response\)$/);
});

test('properties added', async () => {
  const r = await both(obj({}), obj({ a: str, b: str }, ['a']));
  assert.deepEqual(r.req, ['error:request-property-added-required', 'info:request-property-added']);
  assert.deepEqual(r.res, ['info:response-property-added', 'info:response-property-added']);
});

test('properties became required / optional', async () => {
  const r = await both(obj({ a: str, b: str }, ['a']), obj({ a: str, b: str }, ['b']));
  assert.deepEqual(r.req.sort(), ['info:request-property-became-optional', 'error:request-property-became-required'].sort());
  assert.deepEqual(r.res.sort(), ['error:response-property-became-optional', 'info:response-property-became-required'].sort());
});

test('readOnly and writeOnly properties', async () => {
  // readOnly properties are never sent: adding a required one doesn't break requests.
  let r = await both(obj({}), obj({ id: { type: 'string', readOnly: true } }, ['id']));
  assert.deepEqual(r.req, []);
  assert.deepEqual(r.res, ['info:response-property-added']);
  // writeOnly properties are never returned.
  r = await both(obj({ password: { type: 'string', writeOnly: true } }, ['password']), obj({}));
  assert.deepEqual(r.req, ['warning:request-property-removed']);
  assert.deepEqual(r.res, []);
  r = await both(obj({ a: str }), obj({ a: { type: 'string', readOnly: true } }));
  assert.deepEqual(r.req, ['warning:request-property-became-read-only']);
  r = await both(obj({ a: str }), obj({ a: { type: 'string', writeOnly: true } }));
  assert.deepEqual(r.res, ['error:response-property-became-write-only']);
  // No longer read-only and required: clients must now send it.
  r = await both(obj({ a: { type: 'string', readOnly: true } }, ['a']), obj({ a: str }, ['a']));
  assert.deepEqual(r.req, ['error:request-property-added-required']);
});

test('property deprecated', async () => {
  const r = await both(obj({ a: str }), obj({ a: { type: 'string', deprecated: true } }));
  assert.deepEqual(r.req, ['info:request-property-deprecated']);
  assert.deepEqual(r.res, ['info:response-property-deprecated']);
});

test('nested properties and arrays name the full path', async () => {
  const a = obj({ order: obj({ lines: { type: 'array', items: obj({ sku: str, qty: { type: 'integer' } }) } }) });
  const b = obj({ order: obj({ lines: { type: 'array', items: obj({ sku: str }) } }) });
  const r = await diff(withResponse(a), withResponse(b));
  assert.deepEqual(ids(r), ['warning:response-property-removed']);
  assert.match(r.changes[0].message, /`order\.lines\[\]\.qty`/);
});

test('schema rules on a property use the property prefix', async () => {
  const r = await both(obj({ a: { type: 'integer', maximum: 5 } }), obj({ a: { type: 'string' } }));
  assert.deepEqual(r.req, ['error:request-property-type-changed']);
  const q = await both(obj({ a: { type: 'integer', maximum: 5 } }), obj({ a: { type: 'integer', maximum: 3, nullable: true } }));
  assert.deepEqual(q.req.sort(), ['error:request-property-max-decreased', 'info:request-property-became-nullable'].sort());
  assert.deepEqual(q.res.sort(), ['info:response-property-max-decreased', 'warning:response-property-became-nullable'].sort());
});

test('a root array: changes to its items keep the body prefix', async () => {
  const r = await diff(withResponse({ type: 'array', items: str }), withResponse({ type: 'array', items: { type: 'integer' } }));
  assert.deepEqual(ids(r), ['error:response-body-type-changed']);
  assert.match(r.changes[0].message, /items/);
});

test('additionalProperties tightened in requests, loosened in responses', async () => {
  let r = await both(obj({ a: str }), { ...obj({ a: str }), additionalProperties: false });
  assert.deepEqual(r.req, ['error:request-body-additional-properties-restricted']);
  assert.deepEqual(r.res, []);
  r = await both(obj({ a: str }), { ...obj({ a: str }), additionalProperties: str });
  assert.deepEqual(r.req, ['warning:request-body-additional-properties-restricted']);
  r = await both({ ...obj({ a: str }), additionalProperties: false }, obj({ a: str }));
  assert.deepEqual(r.req, []);
  assert.deepEqual(r.res, ['warning:response-body-additional-properties-allowed']);
  // Map values are compared.
  r = await both({ type: 'object', additionalProperties: str }, { type: 'object', additionalProperties: { type: 'integer' } });
  assert.deepEqual(r.res, ['error:response-property-type-changed']);
  assert.match(r.resR.changes[0].message, /`\*`/);
});

test('oneOf / anyOf options matched by the schema they reference', async () => {
  const comps = { components: { schemas: { Cat: obj({ meow: str }), Dog: obj({ bark: str }), Fish: obj({ fins: { type: 'integer' } }) } } };
  const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
  const a = withResponse({ oneOf: [ref('Cat'), ref('Dog')] }, comps);
  const b = withResponse({ oneOf: [ref('Dog'), ref('Fish')] }, comps);
  const r = await diff(a, b);
  assert.deepEqual(ids(r), ['info:response-body-subschema-removed', 'warning:response-body-subschema-added']);
  const q = await diff(withRequest({ anyOf: [ref('Cat'), ref('Dog')] }, comps), withRequest({ anyOf: [ref('Cat')] }, comps));
  assert.deepEqual(ids(q), ['error:request-body-subschema-removed']);
  const added = await diff(withRequest({ anyOf: [ref('Cat')] }, comps), withRequest({ anyOf: [ref('Cat'), ref('Dog')] }, comps));
  assert.deepEqual(ids(added), ['info:request-body-subschema-added']);
});

test('changes inside a matched option are reported with its name', async () => {
  const s = (catProps) => withResponse({ type: 'object', properties: { pet: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] } } }, { components: { schemas: { Cat: obj(catProps, ['meow']), Dog: obj({ bark: str }) } } });
  const r = await diff(s({ meow: str }), s({}));
  assert.deepEqual(ids(r), ['error:response-property-removed']);
  assert.match(r.changes[0].message, /`pet\(Cat\)\.meow`/);
});

test('allOf members are merged', async () => {
  const comps = (extra) => ({ components: { schemas: { Base: obj({ id: str }, ['id']), ...extra } } });
  const a = withResponse({ allOf: [{ $ref: '#/components/schemas/Base' }, obj({ name: str }, ['name'])] }, comps());
  const b = withResponse({ allOf: [{ $ref: '#/components/schemas/Base' }, obj({ name: str })] }, comps());
  assert.deepEqual(ids(await diff(a, b)), ['error:response-property-became-optional']);
  // Moving a property into an allOf member is not a change.
  const c = withResponse(obj({ id: str, name: str }, ['id']), comps());
  const d = withResponse({ allOf: [{ $ref: '#/components/schemas/Base' }, obj({ name: str })] }, comps());
  assert.deepEqual(ids(await diff(c, d)), []);
});

// --- security ----------------------------------------------------------------------------

const schemes = { components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' }, oauth: { type: 'oauth2', flows: {} }, basic: { type: 'http', scheme: 'basic' } } } };
const secured = (security, root) => spec({ '/x': { get: { ...(security !== undefined ? { security } : {}), responses: ok } } }, { ...schemes, ...(root !== undefined ? { security: root } : {}) });

test('security added to an open endpoint', async () => {
  assert.deepEqual(ids(await diff(secured(), secured([{ key: [] }]))), ['error:security-added']);
  // Optional auth ({} as an alternative) still allows anonymous calls.
  assert.deepEqual(ids(await diff(secured([{}, { key: [] }]), secured([{ key: [] }]))), ['error:security-added']);
  assert.deepEqual(ids(await diff(secured(), secured([{}, { key: [] }]))), []);
});

test('security removed', async () => {
  assert.deepEqual(ids(await diff(secured([{ key: [] }]), secured([]))), ['info:security-removed']);
});

test('security alternatives added and removed', async () => {
  assert.deepEqual(ids(await diff(secured([{ key: [] }]), secured([{ key: [] }, { basic: [] }]))), ['info:security-requirement-added']);
  assert.deepEqual(ids(await diff(secured([{ key: [] }, { basic: [] }]), secured([{ key: [] }]))), ['error:security-requirement-removed']);
  // Switching from one scheme to another.
  assert.deepEqual(ids(await diff(secured([{ key: [] }]), secured([{ basic: [] }]))), ['error:security-requirement-removed', 'info:security-requirement-added']);
});

test('an AND requirement that drops a scheme is loosened; one that gains a scheme is tightened', async () => {
  let r = await diff(secured([{ key: [], oauth: [] }]), secured([{ key: [] }]));
  assert.deepEqual(ids(r), ['info:security-requirement-loosened']);
  assert.match(r.changes[0].message, /no longer needs `oauth`/);
  r = await diff(secured([{ key: [] }]), secured([{ key: [], oauth: [] }]));
  assert.deepEqual(ids(r), ['error:security-requirement-removed']);
  assert.match(r.changes[0].message, /now also needs `oauth`/);
});

test('security scopes', async () => {
  const r = await diff(secured([{ oauth: ['read'] }]), secured([{ oauth: ['read', 'write'] }]));
  assert.deepEqual(ids(r), ['error:security-scope-added']);
  assert.deepEqual(ids(await diff(secured([{ oauth: ['read', 'write'] }]), secured([{ oauth: ['read'] }]))), ['info:security-scope-removed']);
});

test('root-level security applies to operations without their own', async () => {
  assert.deepEqual(ids(await diff(secured(undefined, []), secured(undefined, [{ key: [] }]))), ['error:security-added']);
  // An operation that opts out stays open.
  assert.deepEqual(ids(await diff(secured([], []), secured([], [{ key: [] }]))), []);
});

test('security scheme changed', async () => {
  const s = (name) => spec({}, { components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name } } } });
  const r = await diff(s('X-Key'), s('X-Api-Key'));
  assert.deepEqual(ids(r), ['error:security-scheme-changed']);
});

// --- general -----------------------------------------------------------------------------

test('servers and API version', async () => {
  const s = (urls, version) => ({ ...spec({}), info: { title: 'T', version }, servers: urls.map((url) => ({ url })) });
  const r = await diff(s(['https://a.example/v1', 'https://b.example/'], '1.0'), s(['https://b.example', 'https://c.example/v2'], '2.0'));
  assert.deepEqual(ids(r), ['info:api-version-changed', 'info:server-removed', 'info:server-added']);
  assert.equal(r.changes[0].path, undefined);
});

test('descriptions, examples and summaries are not compared', async () => {
  const a = withResponse({ ...obj({ a: { type: 'string', description: 'old', example: 'x' } }), title: 'A' });
  const b = withResponse({ ...obj({ a: { type: 'string', description: 'new', example: 'y' } }), title: 'B' });
  a.paths['/x'].get.summary = 'one';
  b.paths['/x'].get.summary = 'two';
  assert.deepEqual(ids(await diff(a, b)), []);
});

test('comparing a spec with itself finds nothing', async () => {
  const s = withResponse(obj({ a: str, b: { type: 'array', items: obj({ c: { type: 'integer', maximum: 3 } }) } }, ['a']));
  assert.deepEqual(ids(await diff(s, s)), []);
});

// --- moved endpoints ---------------------------------------------------------------------

const petOp = (extra = {}) => ({
  summary: 'Get a pet',
  tags: ['pets'],
  parameters: [
    { name: 'id', in: 'path', required: true, schema: str },
    { name: 'fields', in: 'query', schema: str },
  ],
  responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 404: { description: 'no' } },
  ...extra,
});
const petComps = { components: { schemas: { Pet: obj({ id: str, name: str }, ['id']) } } };

test('an endpoint that moved with its operationId is one breaking change, not a removal and an addition', async () => {
  const a = spec({ '/pets/{id}': { get: petOp({ operationId: 'getPet' }) } }, petComps);
  const b = spec({ '/animals/{id}': { get: petOp({ operationId: 'getPet', summary: 'Fetch an animal' }) } }, petComps);
  const r = await diff(a, b);
  assert.deepEqual(ids(r), ['error:endpoint-moved']);
  const [c] = r.changes;
  assert.equal(c.path, '/animals/{id}');
  assert.deepEqual(c.movedFrom, { method: 'GET', path: '/pets/{id}' });
  assert.match(c.message, /`GET \/pets\/\{id\}` is now `GET \/animals\/\{id\}` \(same operationId `getPet`\)/);
  assert.ok(c.old.pointer.startsWith('/paths/~1pets~1{id}/get') && c.new.pointer.startsWith('/paths/~1animals'));
});

test('without an operationId, a nearly identical operation counts as moved and says how alike it is', async () => {
  const a = spec({ '/v1/pets/{id}': { get: petOp() } }, petComps);
  const b = spec({ '/v2/pets/{id}': { get: petOp() } }, petComps);
  const r = await diff(a, b);
  assert.deepEqual(ids(r), ['error:endpoint-moved']);
  assert.match(r.changes[0].message, /no operationId to go by; \d+% of what it takes and returns is the same/);
});

test('changes to a moved endpoint are reported too, on its new path', async () => {
  const a = spec({ '/pets/{id}': { get: petOp({ operationId: 'getPet' }) } }, petComps);
  const b = spec({ '/animals/{id}': { get: petOp({ operationId: 'getPet', parameters: [...petOp().parameters, { name: 'tenant', in: 'header', required: true, schema: str }] }) } }, petComps);
  const r = await diff(a, b);
  assert.deepEqual(ids(r), ['error:endpoint-moved', 'error:request-parameter-added-required']);
  assert.ok(r.changes.every((c) => c.path === '/animals/{id}' && c.movedFrom?.path === '/pets/{id}'));
});

test('moves are not guessed when the operations differ, are ambiguous, or detection is off', async () => {
  // Different operationIds: different operations.
  const a = spec({ '/pets/{id}': { get: petOp({ operationId: 'getPet' }) } }, petComps);
  const b = spec({ '/animals/{id}': { get: petOp({ operationId: 'getAnimal' }) } }, petComps);
  assert.deepEqual(ids(await diff(a, b)), ['error:endpoint-removed', 'info:endpoint-added']);
  // Two equally good candidates: neither is picked.
  const two = spec({ '/x/{id}': { get: petOp() }, '/y/{id}': { get: petOp() } }, petComps);
  assert.deepEqual(ids(await diff(spec({ '/pets/{id}': { get: petOp() } }, petComps), two)).sort(), ['error:endpoint-removed', 'info:endpoint-added', 'info:endpoint-added']);
  // Too little in common.
  const thin = (p) => spec({ [p]: { get: { responses: ok } } });
  assert.deepEqual(ids(await diff(thin('/a'), thin('/b'))), ['error:endpoint-removed', 'info:endpoint-added']);
  // Turned off, or limited to operationIds.
  const same = spec({ '/animals/{id}': { get: petOp({ operationId: 'getPet' }) } }, petComps);
  const off = await core.compare({ text: JSON.stringify(a), path: '/a.json' }, { text: JSON.stringify(same), path: '/b.json' }, { renames: 'off' });
  assert.deepEqual(off.changes.map((c) => c.id), ['endpoint-removed', 'endpoint-added']);
  const byId = await core.compare({ text: JSON.stringify(spec({ '/v1/p/{id}': { get: petOp() } }, petComps)), path: '/a.json' }, { text: JSON.stringify(spec({ '/v2/p/{id}': { get: petOp() } }, petComps)), path: '/b.json' }, { renames: 'operationId' });
  assert.deepEqual(byId.changes.map((c) => c.id), ['endpoint-removed', 'endpoint-added']);
});

test('a moved deprecated endpoint is possibly breaking; a method change with the same operationId is a move', async () => {
  const a = spec({ '/pets/{id}': { get: petOp({ operationId: 'getPet', deprecated: true }) } }, petComps);
  const b = spec({ '/animals/{id}': { get: petOp({ operationId: 'getPet', deprecated: true }) } }, petComps);
  assert.deepEqual(ids(await diff(a, b)), ['warning:endpoint-moved']);
  const c = spec({ '/search': { post: { operationId: 'search', responses: ok } } });
  const d = spec({ '/search': { query: { operationId: 'search', responses: ok } } });
  const r = await diff(c, d);
  assert.deepEqual(ids(r), ['error:endpoint-moved']);
  assert.match(r.changes[0].message, /`POST \/search` is now `QUERY \/search`/);
});

// --- discriminator and options -------------------------------------------------------------

const pets = (discriminator, options = [ref('Dog'), ref('Cat')]) => ({ oneOf: options, discriminator });
const petSchemas = { components: { schemas: { Dog: obj({ petType: str, bark: str }), Cat: obj({ petType: str, meow: str }) } } };
const mapping = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `#/components/schemas/${v}`]));

test('discriminator property changed breaks both ways', async () => {
  const r = await both(pets({ propertyName: 'petType' }), pets({ propertyName: 'kind' }), petSchemas);
  assert.deepEqual(r.req, ['error:request-body-discriminator-property-changed']);
  assert.deepEqual(r.res, ['error:response-body-discriminator-property-changed']);
});

test('discriminator mapping values added, removed, pointed elsewhere', async () => {
  const d = (m) => pets({ propertyName: 'petType', mapping: mapping(m) });
  let r = await both(d({ dog: 'Dog', cat: 'Cat' }), d({ dog: 'Dog', kitty: 'Cat' }), petSchemas);
  assert.deepEqual(r.req, ['error:request-body-discriminator-mapping-removed', 'info:request-body-discriminator-mapping-added']);
  assert.deepEqual(r.res, ['info:response-body-discriminator-mapping-removed', 'warning:response-body-discriminator-mapping-added']);
  // An option the mapping leaves out is named by its schema: `cat` is gone, `Cat` is new.
  r = await both(d({ dog: 'Dog', cat: 'Cat' }), d({ dog: 'Dog' }), petSchemas);
  assert.deepEqual(r.req, ['error:request-body-discriminator-mapping-removed', 'info:request-body-discriminator-mapping-added']);
  assert.match(r.reqR.changes[1].message, /value `Cat` added/);
  r = await both(d({ dog: 'Dog', cat: 'Cat' }), d({ dog: 'Dog', cat: 'Cat', kitty: 'Cat' }), petSchemas);
  assert.deepEqual(r.req, ['info:request-body-discriminator-mapping-added']);
  assert.deepEqual(r.res, ['warning:response-body-discriminator-mapping-added']);
  r = await both(d({ dog: 'Dog', cat: 'Cat' }), d({ dog: 'Cat', cat: 'Cat' }), petSchemas);
  // Dog, no longer mapped, is now sent as `Dog`.
  assert.deepEqual(r.res, ['warning:response-body-discriminator-mapping-changed', 'warning:response-body-discriminator-mapping-added']);
  assert.match(r.resR.changes[0].message, /discriminator value `dog` now means `Cat` instead of `Dog`/);
  assert.equal(r.resR.changes[0].new.pointer, '/paths/~1x/get/responses/200/content/application~1json/schema/discriminator/mapping/dog');
});

test('options without a name are matched by what they look like, not by position', async () => {
  const s = { oneOf: [{ type: 'string', maxLength: 10 }, obj({ a: str, b: str })] };
  const t = { oneOf: [obj({ a: str, b: str }), { type: 'string', maxLength: 10 }] };
  assert.deepEqual((await both(s, t)).req, []);
  // Still the same option with one more property: the property is the change.
  const u = { oneOf: [obj({ a: str, b: str, c: str }), { type: 'string', maxLength: 10 }] };
  const r = await diff(withResponse(s), withResponse(u));
  assert.deepEqual(ids(r), ['info:response-property-added']);
  assert.match(r.changes[0].message, /`\(#1 object\)\.c`/);
  // Nothing alike: removed and added.
  const v = { oneOf: [{ type: 'string', maxLength: 10 }, { type: 'array', items: { type: 'integer' } }] };
  assert.deepEqual(ids(await diff(withRequest(s), withRequest(v))).sort(), ['error:request-body-subschema-removed', 'info:request-body-subschema-added']);
});

test('inline options are matched by their discriminator value and by title', async () => {
  const opt = (type, extra = {}) => obj({ petType: { type: 'string', enum: [type] }, ...extra });
  const s = { oneOf: [opt('dog'), opt('cat')], discriminator: { propertyName: 'petType' } };
  const t = { oneOf: [opt('cat'), opt('dog', { bark: { type: 'boolean' } })], discriminator: { propertyName: 'petType' } };
  const r = await diff(withResponse(s), withResponse(t));
  assert.deepEqual(ids(r), ['info:response-property-added']);
  assert.match(r.changes[0].message, /`\(dog\)\.bark`/);
  const titled = (a, b) => ({ anyOf: [{ title: 'Card', ...obj({ number: str }) }, { title: 'Bank', ...obj({ iban: str }) }].slice(a, b) });
  assert.deepEqual(ids(await diff(withRequest(titled(0, 2)), withRequest(titled(1, 2)))), ['error:request-body-subschema-removed']);
});

// --- callbacks and webhooks --------------------------------------------------------------

const event = (props, required = []) => ({ post: { requestBody: { required: true, content: { 'application/json': { schema: obj(props, required) } } }, responses: { 200: { description: 'ok' } } } });
const subscribe = (callbacks) => spec({ '/subscribe': { post: { responses: { 201: { description: 'ok' } }, callbacks } } });

test('callbacks: the payload the API sends is judged like a response', async () => {
  const a = subscribe({ onEvent: { '{$request.body#/url}': event({ id: str, note: str, at: str }, ['id']) } });
  const b = subscribe({ onEvent: { '{$request.body#/url}': event({ note: str, at: { type: 'integer' }, extra: str }) } });
  const r = await diff(a, b);
  assert.deepEqual(ids(r).sort(), ['error:callback-request-property-removed', 'error:callback-request-property-type-changed', 'info:callback-request-property-added']);
  assert.ok(r.changes.every((c) => c.method === 'POST' && c.path === '/subscribe'));
  assert.match(r.changes[0].message, /^Callback `onEvent` \(POST `\{\$request\.body#\/url\}`\): payload property `id` was removed \(it was required\)$/);
});

test('callbacks: the answer the client sends is judged like a request', async () => {
  const answer = (required) => ({ '{$request.body#/url}': { post: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' } }, required) } } } } } } });
  const r = await diff(subscribe({ onEvent: answer([]) }), subscribe({ onEvent: answer(['ok']) }));
  assert.deepEqual(ids(r), ['error:callback-response-property-became-required']);
});

test('callbacks added, removed, deprecated, and a new URL expression', async () => {
  const cb = (expr, deprecated) => ({ [expr]: { post: { ...event({ id: str }).post, ...(deprecated ? { deprecated: true } : {}) } } });
  assert.deepEqual(ids(await diff(subscribe({ a: cb('{$request.body#/url}') }), subscribe({}))), ['error:callback-removed']);
  assert.deepEqual(ids(await diff(subscribe({ a: cb('{$request.body#/url}', true) }), subscribe({}))), ['warning:deprecated-callback-removed']);
  assert.deepEqual(ids(await diff(subscribe({}), subscribe({ a: cb('{$request.body#/url}') }))), ['info:callback-added']);
  assert.deepEqual(ids(await diff(subscribe({ a: cb('{$request.body#/url}') }), subscribe({ a: cb('{$request.body#/url}', true) }))), ['info:callback-deprecated']);
  assert.deepEqual(ids(await diff(subscribe({ a: cb('{$request.body#/url}', true) }), subscribe({ a: cb('{$request.body#/url}') }))), ['info:callback-reactivated']);
  const moved = await diff(subscribe({ a: cb('{$request.body#/url}') }), subscribe({ a: cb('{$request.body#/callbackUrl}') }));
  assert.deepEqual(ids(moved), ['error:callback-url-changed']);
  assert.match(moved.changes[0].message, /now taken from `\{\$request\.body#\/callbackUrl\}` instead of `\{\$request\.body#\/url\}`/);
});

const hooks = (webhooks, extra = {}) => spec31({}, { webhooks, ...extra });

test('webhooks added, removed, deprecated; their payload judged like a response', async () => {
  const r = await diff(hooks({ newPet: event({ id: str, name: str }, ['id']), gone: event({}), old: { post: { ...event({}).post, deprecated: true } } }), hooks({ newPet: { post: { ...event({ id: { type: 'integer' }, name: str }, ['id']).post, deprecated: true } }, fresh: event({}) }));
  assert.deepEqual(ids(r), ['info:webhook-deprecated', 'error:webhook-request-property-type-changed', 'error:webhook-removed', 'warning:deprecated-webhook-removed', 'info:webhook-added']);
  const c = r.changes[0];
  assert.equal(c.webhook, true);
  assert.equal(c.path, 'newPet');
  assert.equal(core.endpointLabel(c), 'POST newPet (webhook)');
  assert.deepEqual(ids(await diff(hooks({ a: { post: { ...event({}).post, deprecated: true } } }), hooks({ a: event({}) }))), ['info:webhook-reactivated']);
});

test('inside a webhook every operation rule takes its reversed level', async () => {
  // The operation-level tests above, replayed as webhooks.
  const pairs = [
    [{ parameters: [{ name: 'X-Sig', in: 'header', required: true, schema: str }] }, {}],
    [{}, { parameters: [{ name: 'X-Sig', in: 'header', required: true, schema: str }] }],
    [{ parameters: [{ name: 'X-Sig', in: 'header', schema: str }] }, { parameters: [{ name: 'X-Sig', in: 'header', required: true, schema: str }] }],
    [{ parameters: [{ name: 'X-Sig', in: 'header', required: true, schema: str }] }, { parameters: [{ name: 'X-Sig', in: 'header', schema: str }] }],
    [{ requestBody: { content: { 'application/json': { schema: str } } } }, {}],
    [{}, { requestBody: { required: true, content: { 'application/json': { schema: str } } } }],
    [{ requestBody: { required: true, content: { 'application/json': { schema: str } } } }, { requestBody: { content: { 'application/json': { schema: str }, 'text/plain': { schema: str } } } }],
    [{ requestBody: { content: { 'application/json': { schema: str }, 'text/plain': { schema: str } } } }, { requestBody: { content: { 'application/json': { schema: str } } } }],
    [{ responses: { 200: { description: 'ok' }, 400: { description: 'x' } } }, { responses: { 201: { description: 'ok' } } }],
    [{ operationId: 'a' }, { operationId: 'b' }],
  ];
  const known = new Map(core.allRules().map((r) => [r.id, r]));
  let n = 0;
  for (const [x, y] of pairs) {
    const op = (o) => ({ post: { responses: ok, ...o } });
    const r = await diff(hooks({ h: op(x) }), hooks({ h: op(y) }));
    for (const c of r.changes) {
      n++;
      const rule = known.get(c.id);
      assert.ok(rule?.kind === 'webhook', c.id);
      if (typeof rule.level === 'string') assert.equal(c.level, rule.level, c.id);
    }
  }
  assert.ok(n >= 12, `changes: ${n}`);
});

// --- links, servers, OpenAPI 3.2 ---------------------------------------------------------

test('response links removed, added, retargeted, given other parameters', async () => {
  const s = (links) => spec({ '/x': { get: { responses: { 200: { description: 'ok', links } } } } });
  const owner = { operationId: 'getOwner', parameters: { id: '$response.body#/ownerId' } };
  assert.deepEqual(ids(await diff(s({ owner }), s({}))), ['warning:response-link-removed']);
  assert.deepEqual(ids(await diff(s({}), s({ owner }))), ['info:response-link-added']);
  const r = await diff(s({ owner }), s({ owner: { ...owner, operationId: 'getPerson' } }));
  assert.deepEqual(ids(r), ['warning:response-link-changed']);
  assert.match(r.changes[0].message, /now leads to `getPerson` instead of `getOwner`/);
  assert.deepEqual(ids(await diff(s({ owner }), s({ owner: { ...owner, parameters: { ownerId: '$response.body#/ownerId' } } }))), ['warning:response-link-changed']);
});

test('servers on a path or an operation', async () => {
  const root = { servers: [{ url: 'https://api.example.com' }] };
  const s = (pathServers, opServers) => spec({ '/upload': { ...(pathServers ? { servers: pathServers.map((url) => ({ url })) } : {}), post: { ...(opServers ? { servers: opServers.map((url) => ({ url })) } : {}), responses: ok } } }, root);
  assert.deepEqual(ids(await diff(s(['https://files.example.com']), s(['https://upload.example.com']))), ['warning:endpoint-server-removed', 'info:endpoint-server-added']);
  // An operation that starts using its own server leaves the API's.
  const r = await diff(s(), s(undefined, ['https://upload.example.com']));
  assert.deepEqual(ids(r), ['warning:endpoint-server-removed', 'info:endpoint-server-added']);
  assert.match(r.changes[0].message, /`https:\/\/api\.example\.com` removed for this operation/);
  assert.deepEqual(ids(await diff(s(['https://a.example.com']), s(undefined, ['https://a.example.com/']))), []);
});

test('OpenAPI 3.2: additionalOperations, querystring parameters, itemSchema, deprecated security schemes', async () => {
  const s32 = (paths, extra = {}) => ({ openapi: '3.2.0', info: { title: 'T', version: '1' }, paths, ...extra });
  const r = await diff(s32({ '/files/{id}': { additionalOperations: { COPY: { responses: ok }, LOCK: { responses: ok } } } }), s32({ '/files/{id}': { additionalOperations: { COPY: { responses: ok } } } }));
  assert.deepEqual(ids(r), ['error:endpoint-removed']);
  assert.equal(r.changes[0].method, 'LOCK');
  const qs = (schema) => s32({ '/search': { get: { parameters: [{ name: 'q', in: 'querystring', content: { 'application/x-www-form-urlencoded': { schema } } }], responses: ok } } });
  assert.deepEqual(ids(await diff(qs(obj({ term: str })), qs(obj({ term: str, page: { type: 'integer' } }, ['page'])))), ['error:request-property-added-required']);
  const stream = (schema) => s32({ '/events': { get: { responses: { 200: { description: 'ok', content: { 'application/jsonl': { itemSchema: schema } } } } } } });
  const st = await diff(stream(obj({ id: str, type: str }, ['id'])), stream(obj({ type: str })));
  assert.deepEqual(ids(st), ['error:response-property-removed']);
  assert.match(st.changes[0].message, /200 response \(each streamed item\)/);
  const sec = (deprecated) => s32({}, { components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key', ...(deprecated ? { deprecated } : {}) } } } });
  assert.deepEqual(ids(await diff(sec(false), sec(true))), ['info:security-scheme-deprecated']);
});

// --- coverage ----------------------------------------------------------------------------

test('Swagger 2.0 rules (body, formData, produces, x-nullable, host) are exercised in swagger.test.mjs', async () => {
  // Run the ones only Swagger reaches here too, so the coverage check below sees them.
  const a = swagger({ '/x': { get: { parameters: [{ name: 'q', in: 'query', type: 'array', items: { type: 'string' } }], responses: ok } } });
  const b = swagger({ '/x': { get: { parameters: [{ name: 'q', in: 'query', type: 'array', collectionFormat: 'multi', items: { type: 'string' } }], responses: ok } } });
  assert.deepEqual(ids(await diff(a, b)), ['warning:request-parameter-serialization-changed']);
});

test('every rule in the catalog is produced by some test above', () => {
  // Schema rules run the same code for parameters and headers as for bodies and
  // properties: those are covered through the body and property ids.
  const propertyOnly = new Set(core.SCHEMA_RULES.filter((s) => s.propertyOnly).map((s) => s.rule));
  // Rules inside callbacks and webhooks are the same code with the other level: the
  // reversed-level test above covers them.
  const mustCover = core.allRules().filter((r) => !r.base && (!r.schemaRule || /^(request|response)-body-/.test(r.id) || propertyOnly.has(r.schemaRule)));
  assert.deepEqual(
    mustCover.map((r) => r.id).filter((id) => !produced.has(id)),
    [],
  );
});

test('every change has the level the catalog gives its id', async () => {
  // Re-run a few comparisons and check each change against the catalog.
  const known = new Map(core.allRules().map((r) => [r.id, r]));
  const read = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
  const r = await diff(read('petstore-v1.yaml'), read('petstore-v2.yaml'));
  for (const c of [...r.changes, ...levelChecks]) {
    const rule = known.get(c.id);
    if (rule && typeof rule.level === 'string') assert.equal(c.level, rule.level, `${c.id}: ${c.message}`);
  }
});

test('every rule produced is in the catalog', () => {
  const known = new Set(core.allRules().map((r) => r.id));
  assert.deepEqual([...produced].filter((id) => !known.has(id)), []);
});
