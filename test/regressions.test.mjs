// Cases from reviews: each once gave a wrong answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, diff, ids, ok, spec, spec31, swagger, withRequest, withResponse } from './helpers.mjs';

const str = { type: 'string' };
const obj = (properties, required = []) => ({ type: 'object', required, properties });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const NULL = { type: 'null' };
const req31 = (schema, schemas = {}) => spec31({ '/x': { post: { requestBody: { required: true, content: { 'application/json': { schema } } }, responses: ok } } }, { components: { schemas } });
const res31 = (schema, schemas = {}) => spec31({ '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } } } } }, { components: { schemas } });

// --- null as a oneOf / anyOf option -----------------------------------------------------

test('anyOf: [X, {type: null}] is X that may be null', async () => {
  const U = { U: obj({ id: str }, ['id']) };
  assert.deepEqual(ids(await diff(res31(obj({ s: str })), res31(obj({ s: { anyOf: [str, NULL] } })))), ['warning:response-property-became-nullable']);
  // The same schema written two ways.
  assert.deepEqual(ids(await diff(res31(obj({ s: { type: ['string', 'null'] } })), res31(obj({ s: { anyOf: [str, NULL] } })))), []);
  assert.deepEqual(ids(await diff(res31(obj({ u: ref('U') }), U), res31(obj({ u: { anyOf: [ref('U'), NULL] } }), U))), ['warning:response-property-became-nullable']);
  assert.deepEqual(ids(await diff(req31(obj({ u: { anyOf: [ref('U'), NULL] } }), U), req31(obj({ u: ref('U') }), U))), ['error:request-property-became-not-nullable']);
  // Among other options, null still only makes it nullable.
  const r = await diff(res31({ oneOf: [str, { type: 'integer' }] }), res31({ oneOf: [str, { type: 'integer' }, NULL] }));
  assert.deepEqual(ids(r), ['warning:response-body-became-nullable']);
});

// --- discriminator values ---------------------------------------------------------------

test('discriminator values are the schema names when the mapping leaves them out', async () => {
  const cat = obj({ kind: str, meow: str });
  const pets = (opts, mapping) => ({ oneOf: opts.map(ref), discriminator: { propertyName: 'kind', ...(mapping ? { mapping } : {}) } });
  // Renaming the schema renames the value clients send.
  let r = await diff(withRequest(pets(['Cat']), { components: { schemas: { Cat: cat } } }), withRequest(pets(['Feline']), { components: { schemas: { Feline: cat } } }));
  assert.deepEqual(ids(r), ['error:request-body-discriminator-mapping-removed', 'info:request-body-discriminator-mapping-added']);
  assert.match(r.changes[0].message, /value `Cat` removed/);
  // Implicit `Cat` / `Dog` → explicit `cat` / `dog`.
  const schemas = { components: { schemas: { Cat: cat, Dog: obj({ kind: str, bark: str }) } } };
  r = await diff(withRequest(pets(['Cat', 'Dog']), schemas), withRequest(pets(['Cat', 'Dog'], { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' }), schemas));
  assert.deepEqual(ids(r).sort(), ['error:request-body-discriminator-mapping-removed', 'error:request-body-discriminator-mapping-removed', 'info:request-body-discriminator-mapping-added', 'info:request-body-discriminator-mapping-added']);
  // Writing the implicit mapping out is not a change.
  assert.deepEqual(ids(await diff(withRequest(pets(['Cat', 'Dog']), schemas), withRequest(pets(['Cat', 'Dog'], { Cat: '#/components/schemas/Cat', Dog: '#/components/schemas/Dog' }), schemas))), []);
});

// --- a schema that became a union, and back ---------------------------------------------

test('a schema that became one option of several is compared with that option', async () => {
  const comps = { components: { schemas: { Pet: obj({ id: str }, ['id']), U: obj({ id: str }, ['id']), V: obj({ code: str }, ['code']) } } };
  const r = await diff(withResponse(ref('Pet'), comps), withResponse({ oneOf: [ref('Pet'), obj({ code: str })] }, comps));
  assert.deepEqual(ids(r), ['warning:response-body-subschema-added']);
  assert.deepEqual(ids(await diff(withRequest({ oneOf: [ref('U')] }, comps), withRequest(ref('U'), comps))), []);
  assert.deepEqual(ids(await diff(withRequest({ oneOf: [ref('V'), ref('U')] }, comps), withRequest(ref('U'), comps))), ['error:request-body-subschema-removed']);
  // A change inside the matched option is still found.
  const s = await diff(withRequest(obj({ id: str, n: { type: 'integer' } }, ['id'])), withRequest({ anyOf: [obj({ id: str, n: { type: 'integer', maximum: 5 } }, ['id']), { type: 'array', items: str }] }));
  assert.deepEqual(ids(s).sort(), ['error:request-property-max-decreased', 'info:request-body-subschema-added']);
});

// --- keywords next to $ref (OpenAPI 3.1) ---------------------------------------------------

test('OpenAPI 3.1: keywords next to a $ref apply', async () => {
  const Name = { Name: str };
  const p = (n) => req31(obj({ n }), Name);
  assert.deepEqual(ids(await diff(p({ $ref: '#/components/schemas/Name', maxLength: 10 }), p({ $ref: '#/components/schemas/Name', maxLength: 5 }))), ['error:request-property-max-length-decreased']);
  assert.deepEqual(ids(await diff(p(ref('Name')), p({ $ref: '#/components/schemas/Name', enum: ['a'] }))), ['error:request-property-became-enum']);
  assert.deepEqual(ids(await diff(p({ $ref: '#/components/schemas/Name', maxLength: 10 }), p({ type: 'string', maxLength: 10 }))), []);
  // A description next to it changes nothing.
  assert.deepEqual(ids(await diff(p(ref('Name')), p({ $ref: '#/components/schemas/Name', description: 'The name' }))), []);
  // OpenAPI 3.0 ignores them, as its spec says.
  const p30 = (n) => withRequest(obj({ n }), { components: { schemas: Name } });
  assert.deepEqual(ids(await diff(p30({ $ref: '#/components/schemas/Name', maxLength: 10 }), p30({ $ref: '#/components/schemas/Name', maxLength: 5 }))), []);
});

// --- allOf ------------------------------------------------------------------------------

test('allOf: the tightest limit of all members is the one in effect', async () => {
  const r = await diff(withRequest({ allOf: [{ type: 'string', maxLength: 10 }, { maxLength: 20 }] }), withRequest({ allOf: [{ type: 'string', maxLength: 10 }, { maxLength: 5 }] }));
  assert.deepEqual(ids(r), ['error:request-body-max-length-decreased']);
  assert.match(r.changes[0].message, /from 10 to 5/);
  assert.deepEqual(ids(await diff(withRequest({ allOf: [{ maxLength: 5 }], maxLength: 20 }), withRequest({ allOf: [{ maxLength: 5 }], maxLength: 50 }))), []);
  assert.deepEqual(ids(await diff(withRequest({ allOf: [{ minimum: 1 }, { minimum: 3 }] }), withRequest({ allOf: [{ minimum: 1 }, { minimum: 2 }] }))), ['info:request-body-min-decreased']);
});

// --- Swagger 2.0 to OpenAPI 3 ------------------------------------------------------------

test('Swagger 2.0 form parameters are the request body OpenAPI 3 writes for them', async () => {
  const v2 = swagger({ '/u': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'a', in: 'formData', required: true, type: 'string' }], responses: ok } } });
  const form = (schema, required = true) => spec({ '/u': { post: { requestBody: { required, content: { 'application/x-www-form-urlencoded': { schema } } }, responses: ok } } });
  assert.deepEqual(ids(await diff(v2, form(obj({ a: str }, ['a'])))), []);
  const r = await diff(v2, form(obj({ a: str, b: { type: 'integer' } }, ['a', 'b'])));
  assert.deepEqual(ids(r), ['error:request-property-added-required']);
  // Files are binary strings.
  const up = swagger({ '/f': { post: { consumes: ['multipart/form-data'], parameters: [{ name: 'file', in: 'formData', type: 'file' }], responses: ok } } });
  const up3 = spec({ '/f': { post: { requestBody: { content: { 'multipart/form-data': { schema: obj({ file: { type: 'string', format: 'binary' } }) } } }, responses: ok } } });
  assert.deepEqual(ids(await diff(up, up3)), ['info:request-body-became-optional']);
  // Changes point at the parameter.
  const t = await diff(v2, swagger({ '/u': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'a', in: 'formData', required: true, type: 'integer' }], responses: ok } } }));
  assert.deepEqual(ids(t), ['error:request-property-type-changed']);
  assert.equal(t.changes[0].new.pointer, '/paths/~1u/post/parameters/0/type');
});

test('a Swagger 2.0 spec with no host or basePath has no server to remove', async () => {
  assert.deepEqual(ids(await diff(swagger({}), spec({}))), []);
});

test('`openapi: 3.0` written as a number is OpenAPI 3.0', async () => {
  const yaml = 'openapi: 3.0\ninfo: {title: T, version: "1"}\npaths: {}\n';
  const r = await diff(yaml, yaml);
  assert.equal(r.errors.old, undefined);
  assert.equal(r.versions.old, '3.0');
  assert.equal(core.looksLikeSpec('{"openapi": 3.0, "paths": {}}'), true);
  assert.equal((await diff('{"openapi": 3.0, "info": {"title": "T", "version": "1"}, "paths": {}}', yaml)).errors.old, undefined);
  // 3.1 written as a number stays 3.1.
  assert.equal((await diff('openapi: 3.1\ninfo: {title: T, version: "1"}\npaths: {}\n', yaml)).errors.old, undefined);
});

// --- security ---------------------------------------------------------------------------

test('a security scheme renamed with the same definition is not a change', async () => {
  const s = (name) => spec({ '/x': { get: { security: [{ [name]: [] }], responses: ok } } }, { components: { securitySchemes: { [name]: { type: 'http', scheme: 'bearer' } } } });
  assert.deepEqual(ids(await diff(s('bearerAuth'), s('BearerAuth'))), []);
  // A different definition under a new name is still a removal.
  const t = spec({ '/x': { get: { security: [{ key: [] }], responses: ok } } }, { components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } });
  assert.deepEqual(ids(await diff(s('bearerAuth'), t)), ['error:security-requirement-removed', 'info:security-requirement-added']);
});

// --- moved endpoints at scale -------------------------------------------------------------

const many = (prefix, n) => {
  const paths = {};
  for (let i = 0; i < n; i++)
    paths[`/${prefix}${i}`] = { get: { parameters: [{ name: 'q', in: 'query', schema: str }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: obj({ id: str }) } } } } } };
  return spec(paths);
};

test('many alike operations that all moved: no quadratic copies, no false moves', async () => {
  const t = Date.now();
  const r = await diff(many('old', 600), many('new', 600), { json: true });
  assert.ok(Date.now() - t < 20_000, `took ${Date.now() - t} ms`);
  // All alike: no move is clear, so none is claimed.
  assert.equal(r.changes.filter((c) => c.id === 'endpoint-moved').length, 0);
  assert.deepEqual(r.notes, []);
});

test('too many removed × added operations: moves by operationId only, and the report says so', async () => {
  const r = await diff(many('old', 1001), many('new', 1001), { json: true });
  assert.equal(r.changes.filter((c) => c.id === 'endpoint-moved').length, 0);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /operationId only/);
});

// --- ignore rules -----------------------------------------------------------------------

test('an ignore rule made from a path with `*` in it matches only that path', () => {
  const change = (path) => ({ id: 'endpoint-added', level: 'info', message: '', method: 'GET', path });
  const rule = { method: 'get', path: core.escapePath('/**') };
  assert.equal(rule.path, '/\\*\\*');
  assert.equal(core.matches(rule, change('/**')), true);
  assert.equal(core.matches(rule, change('/users')), false);
  assert.equal(core.matches({ path: core.escapePath('/a/*/b') }, change('/a/x/b')), false);
  // Written by hand, `*` is still a wildcard.
  assert.equal(core.matches({ path: '/users/*' }, change('/users/{id}')), true);
});

// --- what a comparison read ---------------------------------------------------------------

test('the result lists the files each side was read from', async () => {
  const a = spec({ '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './pet.yaml' } } } } } } } });
  const r = await diff(a, a, { files: { '/api/pet.yaml': obj({ id: str }) } });
  assert.deepEqual(r.files.new, ['/api/new/spec.yaml', '/api/new/pet.yaml']);
  assert.deepEqual(r.files.old, ['/api/old/spec.yaml', '/api/old/pet.yaml']);
});

// --- round 4 ------------------------------------------------------------------------------

test('Optional[A] to Optional[A | B]: nullability is judged once, on the union', async () => {
  const schemas = { A: obj({ a: str }, ['a']), B: obj({ b: str }, ['b']) };
  const pet = (s) => obj({ pet: s });
  let r = await diff(req31(pet({ anyOf: [ref('A'), NULL] }), schemas), req31(pet({ anyOf: [ref('A'), ref('B'), NULL] }), schemas));
  assert.deepEqual(ids(r), ['info:request-property-subschema-added']);
  r = await diff(req31(pet({ anyOf: [ref('A'), ref('B'), NULL] }), schemas), req31(pet({ anyOf: [ref('A'), NULL] }), schemas));
  assert.deepEqual(ids(r), ['error:request-property-subschema-removed']);
  r = await diff(req31(pet({ type: ['object', 'null'], properties: { a: str } }), schemas), req31(pet({ oneOf: [ref('A'), ref('B'), NULL] }), schemas));
  assert.ok(!ids(r).some((x) => /nullable/.test(x)), ids(r).join());
  // A real change of nullability is still reported.
  r = await diff(req31(pet({ anyOf: [ref('A'), NULL] }), schemas), req31(pet({ anyOf: [ref('A'), ref('B')] }), schemas));
  assert.deepEqual(ids(r).sort(), ['error:request-property-became-not-nullable', 'info:request-property-subschema-added']);
});

test('a union with `type: object` of its own is compared with its closest option', async () => {
  const comps = { components: { schemas: { A: obj({ a: str }, ['a']), B: obj({ b: str }, ['b']) } } };
  const r = await diff(withResponse(obj({ a: str }, ['a']), comps), withResponse({ type: 'object', oneOf: [ref('A'), ref('B')] }, comps));
  assert.deepEqual(ids(r), ['warning:response-body-subschema-added']);
});

test('allOf: pattern, multipleOf and enum in a later member still count', async () => {
  const all = (...m) => withRequest({ allOf: m });
  let r = await diff(all({ type: 'string', pattern: '^a' }, { pattern: '^ab' }), all({ type: 'string', pattern: '^a' }, { pattern: '^abc$' }));
  assert.deepEqual(ids(r), ['warning:request-body-pattern-changed']);
  r = await diff(all({ type: 'integer', multipleOf: 2 }, { multipleOf: 3 }), all({ type: 'integer', multipleOf: 2 }, { multipleOf: 5 }));
  assert.deepEqual(ids(r), ['error:request-body-multiple-of-changed']);
  // 2 and 3 together are 6.
  assert.deepEqual(ids(await diff(all({ type: 'integer', multipleOf: 2 }, { multipleOf: 3 }), withRequest({ type: 'integer', multipleOf: 6 }))), []);
  r = await diff(all({ type: 'string', enum: ['a', 'b', 'c', 'd'] }, { enum: ['a', 'b', 'c'] }), all({ type: 'string', enum: ['a', 'b', 'c', 'd'] }, { enum: ['a'] }));
  assert.deepEqual(ids(r), ['error:request-body-enum-value-removed']);
});

test('additionalProperties: {} allows anything, like true', async () => {
  const o = { type: 'object', properties: { a: str } };
  assert.deepEqual(ids(await diff(withRequest(o), withRequest({ ...o, additionalProperties: {} }))), []);
  assert.deepEqual(ids(await diff(withRequest({ ...o, additionalProperties: true }), withRequest({ ...o, additionalProperties: { description: 'any' } }))), []);
  assert.deepEqual(ids(await diff(withRequest({ ...o, additionalProperties: {} }), withRequest({ ...o, additionalProperties: str }))), ['warning:request-body-additional-properties-restricted']);
});

test('spec text with backticks or newlines cannot inject Markdown', async () => {
  const evil = 'x` ![t](https://evil.example/p.png) @acme/everyone `y';
  const p = (e) => spec({ '/pets': { get: { parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: e } }], responses: ok } } });
  const r = await diff(p(['cat', evil]), p(['cat']));
  const md = core.toMarkdown(r.changes, 'T');
  assert.ok(md.includes('``` x` ![t](https://evil.example/p.png) @acme/everyone `y ```') || md.includes('`` x` ![t](https://evil.example/p.png) @acme/everyone `y ``'), md);
  assert.equal(core.codeSpan('a\nb'), '`a b`');
  assert.equal(core.codeSpan('a`b'), '`` a`b ``');
  const notes = core.toReleaseNotes([], { from: '`v1`', to: 'the working copy', versions: { old: '1', new: '2\n# ![x](y)' }, spec: 'a`b.yaml' });
  assert.match(notes, /^## API 2 # !\\\[x\\\]\(y\)\n/);
  assert.ok(notes.includes('in `` a`b.yaml ``'), notes);
});

test('unrelated endpoints that share boilerplate are not a move', async () => {
  const params = [{ name: 'id', in: 'path', required: true, schema: str }, { name: 'X-Request-Id', in: 'header', schema: str }, { name: 'fields', in: 'query', schema: str }];
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 429, 500, 503].map((c) => [c, { description: 'e' }]));
  const op = (schema) => ({ get: { tags: ['projects'], parameters: params, responses: { 200: { description: 'ok', content: { 'application/json': { schema } } }, ...errors } } });
  const base = { '/api/v1/projects/{id}': op(ref('Project')) };
  const comps = { components: { schemas: { Project: obj({ id: str }), Settings: obj({ a: str }), Member: obj({ m: str }) } } };
  const r = await diff(spec({ ...base, '/api/v1/projects/{id}/settings': op(ref('Settings')) }, comps), spec({ ...base, '/api/v1/projects/{id}/members': op({ type: 'array', items: ref('Member') }) }, comps));
  assert.deepEqual(ids(r), ['error:endpoint-removed', 'info:endpoint-added']);
});

test('a property named example that refers to another file is followed', async () => {
  const s = (ex, ot) => withResponse({ type: 'object', properties: { example: { $ref: ex }, default: { $ref: ot } } });
  const r = await diff(s('./Ex.json', './Ot.json'), s('./Ex2.json', './Ot2.json'), { files: { '/api/Ex.json': str, '/api/Ex2.json': { type: 'integer' }, '/api/Ot.json': str, '/api/Ot2.json': { type: 'integer' } } });
  assert.deepEqual(ids(r), ['error:response-property-type-changed', 'error:response-property-type-changed']);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.files.old.some((f) => f.endsWith('Ex.json')));
});

test('only a top-level openapi or swagger key makes a spec', () => {
  assert.equal(core.looksLikeSpec('{"name":"x","dependencies":{"express":"^4.19.0","swagger":"0.7.5"}}'), false);
  assert.equal(core.looksLikeSpec('{"a": {"openapi": "3.0.0"}, "b": "\\"openapi\\": 3"}'), false);
  // Keys sorted: `openapi` comes after a large `components`.
  const big = 'x'.repeat(300_000);
  assert.equal(core.looksLikeSpec(JSON.stringify({ components: { schemas: { A: { description: big } } }, info: { title: 't', version: '1' }, openapi: '3.0.0', paths: {} })), true);
  assert.equal(core.looksLikeSpec(`components:\n  schemas:\n    A:\n      description: ${big}\ninfo:\n  title: t\nopenapi: 3.0.0\npaths: {}\n`), true);
});
