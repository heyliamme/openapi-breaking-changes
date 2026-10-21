// Parsing, positions, references, versions and malformed input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, diff, ids, ok, spec, withResponse } from './helpers.mjs';

const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle));

test('JSON: positions of properties and items', () => {
  const text = '{\n  "a": 1,\n  "list": [\n    10,\n    {"b": true}\n  ]\n}';
  const r = core.parseJson(text);
  assert.equal(r.error, undefined);
  const starts = core.lineStarts(text);
  const at = (obj, key) => core.position(starts, r.locs.get(obj).get(key)).line;
  assert.equal(at(r.value, 'a'), 1);
  assert.equal(at(r.value, 'list'), 2);
  assert.equal(at(r.value.list, '1'), 4);
});

test('JSON: errors carry an offset, duplicate keys keep the last, __proto__ is a plain key', () => {
  const bad = core.parseJson('{\n  "a": 1,\n  "b": \n}');
  assert.ok(bad.error);
  assert.equal(core.position(core.lineStarts('{\n  "a": 1,\n  "b": \n}'), bad.error.offset).line, 3);
  assert.deepEqual(core.parseJson('{"a": 1, "a": 2}').value, { a: 2 });
  const p = core.parseJson('{"__proto__": {"x": 1}}').value;
  assert.deepEqual(Object.keys(p), ['__proto__']);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(core.parseJson('﻿{"a": "\\u00e9\\n"}').value.a, 'é\n');
  assert.ok(core.parseJson('{"a": 1} trailing').error);
  assert.ok(core.parseJson('[1, 2').error);
  assert.ok(core.parseJson('{"a": tru}').error);
});

test('JSON with comments or trailing commas falls back to YAML', () => {
  const r = core.parseText('{"a": 1, "b": [1, 2,],}');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, { a: 1, b: [1, 2] });
});

test('YAML: positions, anchors, merge keys', () => {
  const text = ['base: &base', '  type: string', '  maxLength: 3', 'a:', '  <<: *base', '  maxLength: 5', 'b: *base', 'list:', '  - one', '  - two'].join('\n');
  const r = core.parseYaml(text);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value.a, { maxLength: 5, type: 'string' });
  assert.equal(r.value.b, r.value.base); // aliases share the object
  const starts = core.lineStarts(text);
  assert.equal(core.position(starts, r.locs.get(r.value).get('list')).line, 7);
  assert.equal(core.position(starts, r.locs.get(r.value.list).get('1')).line, 9);
  assert.equal(core.position(starts, r.locs.get(r.value.a).get('maxLength')).line, 5);
});

test('YAML: errors carry an offset; recursive aliases do not loop', () => {
  const r = core.parseYaml('a: [1, 2\nb: 3');
  assert.ok(r.error);
  const rec = core.parseYaml('a: &x\n  self: *x');
  assert.equal(rec.error, undefined);
  assert.equal(rec.value.a.self, rec.value.a);
});

test('looksLikeSpec', () => {
  assert.ok(core.looksLikeSpec('openapi: 3.0.0\ninfo: {}'));
  assert.ok(core.looksLikeSpec('# comment\nswagger: "2.0"\n'));
  assert.ok(core.looksLikeSpec('{\n  "info": {},\n  "openapi": "3.1.0"\n}'));
  assert.ok(core.looksLikeSpec("'openapi': '3.0.1'"));
  assert.ok(!core.looksLikeSpec('name: app\nversion: 2'));
  assert.ok(!core.looksLikeSpec('services:\n  web:\n    openapi: 3.0.0'));
  assert.ok(!core.looksLikeSpec('{"name": "x", "description": "openapi: 3"}'));
});

test('resolvePath', () => {
  assert.equal(core.resolvePath('/a/b/spec.yaml', 'schemas/pet.yaml'), '/a/b/schemas/pet.yaml');
  assert.equal(core.resolvePath('/a/b/spec.yaml', '../common.yaml'), '/a/common.yaml');
  assert.equal(core.resolvePath('/a/b/spec.yaml', './x%20y.yaml'), '/a/b/x y.yaml');
  assert.equal(core.resolvePath('/a/b/spec.yaml', 'https://example.com/x.yaml'), undefined);
  assert.equal(core.resolvePath('/a/spec.yaml', '../../../etc/passwd'), '/etc/passwd');
});

test('versions: unsupported and missing', async () => {
  const r = await core.compare({ text: 'openapi: 4.0.0\npaths: {}', path: '/a.yaml' }, { text: 'openapi: 3.0.0\npaths: {}', path: '/b.yaml' });
  assert.match(r.errors.old.message, /Unsupported version/);
  const m = await core.compare({ text: 'name: x', path: '/a.yaml' }, { text: 'openapi: 3.0.0\npaths: {}', path: '/b.yaml' });
  assert.match(m.errors.old.message, /no `openapi` or `swagger` field/);
  const l = await core.compare({ text: '- 1\n- 2', path: '/a.yaml' }, { text: 'openapi: 3.0.0', path: '/b.yaml' });
  assert.match(l.errors.old.message, /not an object/);
});

test('malformed input reports the line and never throws', async () => {
  const r = await core.compare({ text: 'openapi: 3.0.0\npaths:\n  /a: [\n', path: '/a.yaml' }, { text: '{"openapi": "3.0.0",\n "paths": {\n}', path: '/b.json' });
  assert.ok(r.errors.old);
  assert.ok(r.errors.new);
  assert.equal(typeof r.errors.new.line, 'number');
  assert.deepEqual(r.changes, []);
  // Wrong shapes everywhere: still no exception.
  const weird = { openapi: '3.0.0', paths: { '/a': { get: { parameters: 'x', responses: [1, 2], requestBody: 5, security: 'none' } }, '/b': null, '/c': { post: [] } }, components: 7, servers: 'x' };
  const weird2 = { openapi: '3.0.0', paths: { '/a': { get: { parameters: [null, 1, { name: 3 }], responses: { 200: null, 201: { content: { 'a/b': null } } } } } } };
  await diff(weird, weird2);
  await diff(weird2, weird);
});

test('changes point at the line in each spec, YAML and JSON', async () => {
  const a = withResponse({ type: 'object', properties: { name: { type: 'string' }, tag: { type: 'string' } } });
  const b = withResponse({ type: 'object', properties: { name: { type: 'integer' } } });
  for (const json of [false, true]) {
    const r = await diff(a, b, { json });
    const type = r.changes.find((c) => c.id === 'response-property-type-changed');
    const removed = r.changes.find((c) => c.id === 'response-property-removed');
    const { stringify } = await import('yaml');
    const ta = json ? JSON.stringify(a, null, 2) : stringify(a);
    const tb = json ? JSON.stringify(b, null, 2) : stringify(b);
    // The `type` keyword under `name`.
    assert.equal(type.old.line, lineOf(ta, 'name') + 1, `old line (${json ? 'json' : 'yaml'})`);
    assert.equal(type.new.line, lineOf(tb, 'name') + 1, `new line (${json ? 'json' : 'yaml'})`);
    assert.equal(removed.old.line, lineOf(ta, 'tag'));
    assert.equal(removed.new.line, lineOf(tb, 'properties'), 'removed: points at where it was in the new spec');
    assert.equal(type.old.pointer, '/paths/~1x/get/responses/200/content/application~1json/schema/properties/name/type');
    assert.equal(type.new.file, '/api/new/spec.yaml');
  }
});

test('schema keyword changes point at the keyword', async () => {
  const s = (max) => withResponse({ type: 'object', properties: { n: { type: 'integer', description: 'x', maximum: max } } });
  const { stringify } = await import('yaml');
  const r = await diff(s(10), s(5));
  assert.equal(r.changes[0].new.line, lineOf(stringify(s(5)), 'maximum'));
  assert.match(r.changes[0].new.pointer, /\/maximum$/);
});

test('changes inside a $ref point at the component', async () => {
  const s = (t) => spec({ '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } } } }, { components: { schemas: { Pet: { type: 'object', properties: { name: { type: t } } } } } });
  const r = await diff(s('string'), s('integer'));
  assert.equal(r.changes[0].old.pointer, '/components/schemas/Pet/properties/name/type');
});

test('references to other files are followed and located', async () => {
  const files = { '/api/schemas/pet.yaml': { Pet: { type: 'object', properties: { name: { type: 'string' } } } } };
  const filesB = { '/api/schemas/pet.yaml': { Pet: { type: 'object', properties: { name: { type: 'integer' } } } } };
  const s = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '../schemas/pet.yaml#/Pet' } } } } } } } } };
  // Old and new read different copies of the referenced file.
  const r = await core.compare(
    { text: JSON.stringify(s), path: '/api/v/spec.json', read: async (p) => (p === '/api/schemas/pet.yaml' ? JSON.stringify(files[p]) : undefined) },
    { text: JSON.stringify(s), path: '/api/v/spec.json', read: async (p) => (p === '/api/schemas/pet.yaml' ? JSON.stringify(filesB[p]) : undefined) },
  );
  assert.deepEqual(ids(r), ['error:response-property-type-changed']);
  assert.equal(r.changes[0].old.file, '/api/schemas/pet.yaml');
  assert.equal(r.changes[0].old.pointer, '/Pet/properties/name/type');
});

test('nested file references, a whole-file reference, and a file that loops back', async () => {
  const pet = (t) => ({ type: 'object', properties: { owner: { $ref: 'owner.yaml' }, name: { type: t } } });
  const owner = { type: 'object', properties: { pets: { type: 'array', items: { $ref: 'pet.yaml' } } } };
  const s = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: 'models/pet.yaml' } } } } } } } } };
  const side = (t) => ({ text: JSON.stringify(s), path: '/r/spec.json', read: async (p) => ({ '/r/models/pet.yaml': JSON.stringify(pet(t)), '/r/models/owner.yaml': JSON.stringify(owner) })[p] });
  const r = await core.compare(side('string'), side('integer'));
  assert.deepEqual(ids(r), ['error:response-property-type-changed']);
  assert.equal(r.changes[0].old.file, '/r/models/pet.yaml');
});

test('unreadable, remote and broken references become warnings', async () => {
  const s = (ref) => ({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } } } } } });
  for (const ref of ['missing.yaml#/X', 'https://example.com/s.yaml#/X', '#/components/schemas/Nope', '#anchor']) {
    const r = await diff(s(ref), s(ref));
    assert.deepEqual(r.changes, [], ref);
    assert.equal(r.warnings.length >= 1, true, ref);
  }
});

test('$ref chains and loops are safe', async () => {
  const comps = { components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' }, C: { $ref: '#/components/schemas/D' }, D: { type: 'string' } } } };
  const s = (name) => withResponse({ $ref: `#/components/schemas/${name}` }, comps);
  const loop = await diff(s('A'), s('A'));
  assert.deepEqual(loop.changes, []);
  assert.ok(loop.warnings.some((w) => /loops/.test(w)));
  assert.deepEqual(ids(await diff(s('C'), withResponse({ type: 'integer' }))), ['error:response-body-type-changed']);
});

test('recursive schemas: each change once per endpoint, at its shortest path', async () => {
  const node = (extra) => ({ type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, parent: { $ref: '#/components/schemas/Node' }, ...extra } });
  const s = (extra) => withResponse({ $ref: '#/components/schemas/Node' }, { components: { schemas: { Node: node(extra) } } });
  const r = await diff(s({ id: { type: 'string' } }), s({}));
  assert.deepEqual(ids(r), ['warning:response-property-removed']);
  assert.match(r.changes[0].message, /`id`/);
});

test('mutually recursive schemas', async () => {
  const comps = (t) => ({ components: { schemas: { A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' }, x: { type: t } } }, B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' }, y: { type: 'string' } } } } } });
  const s = (t) => spec({ '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } }, '/b': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/B' } } } } } } } }, comps(t));
  const r = await diff(s('string'), s('integer'));
  assert.deepEqual(r.changes.map((c) => `${c.path} ${c.message}`), ['/a Response property `x` type changed from `string` to `integer` (200 response)', '/b Response property `a.x` type changed from `string` to `integer` (200 response)']);
});

test('a schema that references itself through allOf', async () => {
  const s = withResponse({ $ref: '#/components/schemas/A' }, { components: { schemas: { A: { allOf: [{ $ref: '#/components/schemas/A' }, { type: 'object', properties: { a: { type: 'string' } } }] } } } });
  assert.deepEqual((await diff(s, s)).changes, []);
});

test('large specs compare in reasonable time', async () => {
  const schemas = {};
  for (let i = 0; i < 400; i++) {
    const properties = {};
    for (let j = 0; j < 20; j++) properties[`f${j}`] = j % 4 === 0 ? { $ref: `#/components/schemas/S${(i * 7 + j) % 400}` } : { type: 'string', maxLength: 10 };
    schemas[`S${i}`] = { type: 'object', properties };
  }
  const paths = {};
  for (let i = 0; i < 800; i++) paths[`/r${i}/{id}`] = { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/S${i % 400}` } } } } } } };
  const a = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths, components: { schemas } };
  const b = JSON.parse(JSON.stringify(a));
  delete b.components.schemas.S5.properties.f1;
  const t = Date.now();
  const r = await diff(a, b, { json: true });
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  assert.ok(r.changes.length > 0 && r.changes.every((c) => c.id === 'response-property-removed'));
  // One per endpoint at most.
  assert.equal(new Set(r.changes.map((c) => c.path)).size, r.changes.length);
});

test('the parse cache does not mix up sides', async () => {
  const a = withResponse({ type: 'string' });
  const b = withResponse({ type: 'integer' });
  assert.equal((await diff(a, b)).changes.length, 1);
  assert.equal((await diff(a, a)).changes.length, 0);
  assert.equal((await diff(b, a)).changes.length, 1);
  void ok;
});

// --- $id and $anchor (OpenAPI 3.1 / JSON Schema 2020-12) ------------------------------------

const pet31 = (petProps, ref, extraSchemas = {}) => ({
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  paths: { '/pet': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } } } } },
  components: { schemas: { Pet: { $id: 'https://example.com/schemas/pet', $anchor: 'pet', type: 'object', required: ['id'], properties: petProps }, ...extraSchemas } },
});

test('$ref to a schema by its $id is followed, not treated as remote', async () => {
  const r = await diff(pet31({ id: { type: 'string' }, name: { type: 'string' } }, 'https://example.com/schemas/pet'), pet31({ name: { type: 'string' } }, 'https://example.com/schemas/pet'));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(ids(r), ['error:response-property-removed']);
  assert.equal(r.changes[0].old.pointer, '/components/schemas/Pet/properties/id');
});

test('$ref to an $anchor, plain or under the $id', async () => {
  for (const ref of ['#pet', 'https://example.com/schemas/pet#pet']) {
    const r = await diff(pet31({ id: { type: 'string' } }, ref), pet31({ id: { type: 'integer' } }, ref));
    assert.deepEqual(r.warnings, [], ref);
    assert.deepEqual(ids(r), ['error:response-property-type-changed'], ref);
  }
});

test('$ref relative to an $id base, and a JSON pointer into an $id resource', async () => {
  const tag = (max) => ({ $id: 'https://example.com/schemas/tag', type: 'object', properties: { label: { type: 'string', maxLength: max } } });
  for (const [prop, ref, path] of [['tag', 'tag', 'tag.label'], ['label', 'tag#/properties/label', 'label']]) {
    const s = (max) => pet31({ id: { type: 'string' }, [prop]: { $ref: ref } }, 'https://example.com/schemas/pet', { Tag: tag(max) });
    const r = await diff(s(20), s(10));
    assert.deepEqual(r.warnings, [], ref);
    assert.deepEqual(ids(r), ['info:response-property-max-length-decreased'], ref);
    assert.ok(r.changes[0].message.includes('`' + path + '`'), r.changes[0].message);
  }
});

test('an anchor nobody declares, and a URL that no $id matches, are warnings', async () => {
  const r = await diff(pet31({}, '#nope'), pet31({}, 'https://elsewhere.example.com/pet.json'));
  assert.deepEqual(r.warnings, ['Old: Reference to an anchor that no schema declares: #nope (in /api/old/spec.yaml)', 'New: Remote reference not followed: https://elsewhere.example.com/pet.json']);
});

test('every path moved, no operationIds: each pairs with its own, quickly', async () => {
  // 1,500 operations under /v1 move to /v2: the move matching must stay well below quadratic.
  const paths = (prefix) => {
    const out = {};
    for (let i = 0; i < 500; i++) {
      const params = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: `f${i}`, in: 'query', schema: { type: 'string' } }];
      const res = (n) => ({ 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { [`r${n}`]: { type: 'string' } } } } } } });
      out[`${prefix}/things${i}/{id}`] = { get: { tags: [`t${i}`], parameters: params, responses: res(i) }, delete: { tags: [`t${i}`], parameters: params, responses: { 204: { description: 'gone' } } }, put: { tags: [`t${i}`], parameters: params, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { [`b${i}`]: { type: 'string' } } } } } }, responses: res(i) } };
    }
    return out;
  };
  const t = Date.now();
  const r = await diff(spec(paths('/v1')), spec(paths('/v2')), { json: true });
  const ms = Date.now() - t;
  assert.equal(r.changes.length, 1500);
  assert.ok(r.changes.every((c) => c.id === 'endpoint-moved' && c.movedFrom.path.replace('/v1/', '/v2/') === c.path));
  assert.ok(ms < 5000, `${ms} ms`);
});
