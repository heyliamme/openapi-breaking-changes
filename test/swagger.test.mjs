// Swagger 2.0, and specs that move from 2.0 to 3.x.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diff, ids, only, spec, swagger } from './helpers.mjs';

const ok = { 200: { description: 'ok' } };

test('body parameters are request bodies', async () => {
  const s = (required, props, req = []) => swagger({ '/pets': { post: { parameters: [{ name: 'body', in: 'body', required, schema: { type: 'object', required: req, properties: props } }], responses: ok } } });
  const r = await diff(s(false, { name: { type: 'string' } }), s(true, { name: { type: 'string' }, kind: { type: 'string' } }, ['kind']));
  assert.deepEqual(ids(r), ['error:request-body-became-required', 'error:request-property-added-required']);
  assert.deepEqual(ids(await diff(swagger({ '/pets': { post: { responses: ok } } }), s(true, {}))), ['error:request-body-added-required']);
  assert.deepEqual(ids(await diff(s(false, {}), swagger({ '/pets': { post: { responses: ok } } }))), ['warning:request-body-removed']);
});

test('non-body parameters carry their schema on themselves', async () => {
  const p = (x) => swagger({ '/pets': { get: { parameters: [{ name: 'limit', in: 'query', type: 'integer', ...x }], responses: ok } } });
  const r = await diff(p({ maximum: 100, enum: [10, 50, 100] }), p({ maximum: 50, enum: [10, 50] }));
  assert.deepEqual(ids(r).sort(), ['error:request-parameter-enum-value-removed', 'error:request-parameter-max-decreased'].sort());
  assert.deepEqual(ids(await diff(p({}), p({ type: 'string' }))), ['error:request-parameter-type-changed']);
  assert.deepEqual(ids(await diff(p({}), p({ required: true }))), ['error:request-parameter-became-required']);
});

test('formData parameters are the properties of a form body', async () => {
  const f = (extra) => swagger({ '/upload': { post: { consumes: ['multipart/form-data'], parameters: [{ name: 'file', in: 'formData', type: 'file' }, ...extra], responses: ok } } });
  const r = await diff(f([]), f([{ name: 'note', in: 'formData', type: 'string', required: true }]));
  assert.deepEqual(ids(r), ['error:request-property-added-required']);
  assert.match(r.changes[0].message, /`note` was added as required \(request body\)/);
  assert.deepEqual(ids(await diff(f([{ name: 'note', in: 'formData', type: 'string' }]), f([]))), ['warning:request-property-removed']);
});

test('consumes and produces are the media types', async () => {
  const s = (consumes, produces) =>
    swagger({ '/pets': { post: { consumes, produces, parameters: [{ name: 'b', in: 'body', schema: { type: 'string' } }], responses: { 200: { description: 'ok', schema: { type: 'string' } } } } } });
  const r = await diff(s(['application/json', 'application/xml'], ['application/json']), s(['application/json'], ['application/json', 'text/plain']));
  assert.deepEqual(ids(r), ['error:request-body-media-type-removed', 'info:response-media-type-added']);
  // Root-level consumes apply when the operation has none.
  const root = (consumes) => ({ ...swagger({ '/pets': { post: { parameters: [{ name: 'b', in: 'body', schema: { type: 'string' } }], responses: ok } } }), consumes });
  assert.deepEqual(ids(await diff(root(['application/json', 'text/xml']), root(['application/json']))), ['error:request-body-media-type-removed']);
});

test('response schemas, headers and definitions', async () => {
  const s = (props, headers) =>
    swagger(
      { '/pets': { get: { responses: { 200: { description: 'ok', headers, schema: { $ref: '#/definitions/Pet' } } } } } },
      { definitions: { Pet: { type: 'object', required: ['id'], properties: props } } },
    );
  const r = await diff(s({ id: { type: 'integer' }, name: { type: 'string', 'x-nullable': false } }, { 'X-Rate': { type: 'integer' } }), s({ id: { type: 'string' }, name: { type: 'string', 'x-nullable': true } }, { 'X-Rate': { type: 'string' } }));
  assert.deepEqual(ids(r).sort(), ['error:response-property-type-changed', 'warning:response-property-became-nullable', 'error:response-header-type-changed'].sort());
  assert.equal(only(r, 'response-property-type-changed')[0].old.pointer, '/definitions/Pet/properties/id/type');
});

test('host, basePath and schemes are the server', async () => {
  const s = (x) => ({ ...swagger({}), ...x });
  const r = await diff(s({ host: 'api.example.com', basePath: '/v1', schemes: ['https'] }), s({ host: 'api.example.com', basePath: '/v2', schemes: ['https'] }));
  assert.deepEqual(ids(r), ['info:server-removed', 'info:server-added']);
  assert.match(r.changes[0].message, /https:\/\/api\.example\.com\/v1/);
});

test('securityDefinitions and security', async () => {
  const s = (security, def = { type: 'apiKey', in: 'header', name: 'X-Key' }) => swagger({ '/x': { get: { security, responses: ok } } }, { securityDefinitions: { key: def, oauth: { type: 'oauth2', flow: 'implicit', authorizationUrl: 'https://a', scopes: { read: '', write: '' } } } });
  assert.deepEqual(ids(await diff(s([]), s([{ key: [] }]))), ['error:security-added']);
  assert.deepEqual(ids(await diff(s([{ oauth: ['read'] }]), s([{ oauth: ['read', 'write'] }]))), ['error:security-scope-added']);
  assert.deepEqual(ids(await diff(s([{ key: [] }]), s([{ key: [] }], { type: 'apiKey', in: 'query', name: 'X-Key' }))), ['error:security-scheme-changed']);
});

test('collectionFormat changes are serialization changes', async () => {
  const p = (collectionFormat) => swagger({ '/x': { get: { parameters: [{ name: 'ids', in: 'query', type: 'array', items: { type: 'string' }, ...(collectionFormat ? { collectionFormat } : {}) }], responses: ok } } });
  assert.deepEqual(ids(await diff(p(), p('csv'))), []);
  assert.deepEqual(ids(await diff(p('csv'), p('pipes'))), ['warning:request-parameter-serialization-changed']);
});

test('a Swagger 2.0 spec and its OpenAPI 3.0 conversion have nothing breaking between them', async () => {
  const v2 = swagger(
    {
      '/pets/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        get: {
          operationId: 'getPet',
          produces: ['application/json'],
          parameters: [{ name: 'fields', in: 'query', type: 'string', enum: ['a', 'b'] }],
          responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } }, 404: { description: 'no' } },
          security: [{ key: [] }],
        },
        put: {
          operationId: 'putPet',
          consumes: ['application/json'],
          produces: ['application/json'],
          parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
          responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } } },
        },
      },
    },
    { host: 'api.example.com', basePath: '/v1', schemes: ['https'], securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } }, definitions: { Pet: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, age: { type: 'integer', format: 'int32', 'x-nullable': true } } } } },
  );
  const v3 = spec(
    {
      '/pets/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'fields', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 404: { description: 'no' } },
          security: [{ key: [] }],
        },
        put: {
          operationId: 'putPet',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
        },
      },
    },
    { servers: [{ url: 'https://api.example.com/v1' }], components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } }, schemas: { Pet: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, age: { type: 'integer', format: 'int32', nullable: true } } } } } },
  );
  const r = await diff(v2, v3);
  assert.deepEqual(ids(r), []);
});
test('2.0 basic and oauth2 schemes are their OpenAPI 3 forms', async () => {
  const op = (security) => ({ '/x': { get: { security, responses: ok } } });
  const v2 = swagger(op([{ basic: [] }, { oauth: ['read'] }]), { securityDefinitions: { basic: { type: 'basic' }, oauth: { type: 'oauth2', flow: 'accessCode', authorizationUrl: 'https://a/auth', tokenUrl: 'https://a/token', scopes: { read: 'r' } } } });
  const v3 = spec(op([{ basic: [] }, { oauth: ['read'] }]), { components: { securitySchemes: { basic: { type: 'http', scheme: 'basic' }, oauth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://a/auth', tokenUrl: 'https://a/token', scopes: { read: 'r' } } } } } } });
  assert.deepEqual(ids(await diff(v2, v3)), []);
  // Renamed on the way: still the same scheme.
  const v3b = spec(op([{ http: [] }, { oauth: ['read'] }]), { components: { securitySchemes: { http: { type: 'http', scheme: 'basic' }, oauth: v3.components.securitySchemes.oauth } } });
  assert.deepEqual(ids(await diff(v2, v3b)), []);
  // A real change is still one.
  const v3c = spec(op([{ basic: [] }, { oauth: ['read'] }]), { components: { securitySchemes: { basic: { type: 'http', scheme: 'bearer' }, oauth: v3.components.securitySchemes.oauth } } });
  assert.deepEqual(ids(await diff(v2, v3c)), ['error:security-scheme-changed']);
});
