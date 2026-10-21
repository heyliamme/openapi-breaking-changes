// Ignore rules, warnings as errors, the Markdown changelog, the view's grouping, and the
// README's list of changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { core, diff, ids } from './helpers.mjs';

const model = createRequire(import.meta.url)('../dist/model.js');

const change = (id, level, method, path, message = 'm') => ({ id, level, method, path, message });

test('readIgnore keeps only sensible entries', () => {
  assert.deepEqual(core.readIgnore(['a-b', ' ', 3, null, { id: 'x', extra: 1 }, { reason: 'only a reason' }, { path: '/a', method: 'GET', reason: 'legacy' }, 'c']), [
    { id: 'a-b' },
    { id: 'x' },
    { path: '/a', method: 'GET', reason: 'legacy' },
    { id: 'c' },
  ]);
  assert.deepEqual(core.readIgnore('nope'), []);
});

test('id patterns', () => {
  assert.ok(core.idMatcher('*-deprecated').test('endpoint-deprecated'));
  assert.ok(core.idMatcher('response-*-added').test('response-property-enum-value-added'));
  assert.ok(!core.idMatcher('endpoint-removed').test('deprecated-endpoint-removed'));
  assert.ok(!core.idMatcher('a.b').test('axb'));
});

test('path patterns', () => {
  const m = (p, path) => core.pathMatcher(p).test(path);
  assert.ok(m('/pets/{id}', '/pets/{id}'));
  assert.ok(m('/pets/*', '/pets/{id}'));
  assert.ok(!m('/pets/*', '/pets/{id}/photos'));
  assert.ok(m('/pets/**', '/pets'));
  assert.ok(m('/pets/**', '/pets/{id}/photos'));
  assert.ok(m('/internal/**', '/internal/a/b'));
  assert.ok(!m('/internal/**', '/internals'));
  assert.ok(m('**', '/anything/at/all'));
  assert.ok(m('/a/', '/a'));
});

test('applyPolicy marks ignored changes and can promote warnings', () => {
  const cs = [change('endpoint-removed', 'error', 'GET', '/a'), change('response-property-enum-value-added', 'warning', 'GET', '/b'), change('server-added', 'info'), change('operation-id-changed', 'warning', 'POST', '/internal/x')];
  const p = core.applyPolicy(cs, { ignore: core.readIgnore(['*-enum-value-added', { path: '/internal/**', reason: 'not public' }]), warningsAsErrors: true });
  assert.deepEqual(
    p.map((c) => [c.level, c.ignored]),
    [
      ['error', undefined],
      ['error', ''],
      ['info', undefined],
      ['error', 'not public'],
    ],
  );
  assert.deepEqual(core.count(p), { error: 1, warning: 0, info: 1, ignored: 2 });
  // The input is left alone.
  assert.equal(cs[1].level, 'warning');
  assert.equal(cs[1].ignored, undefined);
});

test('method rules match case-insensitively; whole-API changes have no endpoint', () => {
  const cs = [change('endpoint-removed', 'error', 'DELETE', '/a'), change('server-removed', 'info')];
  const p = core.applyPolicy(cs, { ignore: [{ method: 'delete' }, { path: '/**' }], warningsAsErrors: false });
  assert.deepEqual(
    p.map((c) => c.ignored),
    ['', undefined],
  );
});

test('Markdown: headings by level, endpoints, shared changes once, ignored left out', () => {
  const cs = [
    change('endpoint-removed', 'error', 'DELETE', '/pets/{id}', 'Endpoint removed'),
    { ...change('response-property-removed', 'error', 'GET', '/pets', 'Response property `name` was removed (200 response)'), old: { file: 'a', pointer: '/c/Pet/name' }, new: { file: 'b', pointer: '/c/Pet' } },
    { ...change('response-property-removed', 'error', 'GET', '/pets/{id}', 'Response property `name` was removed (200 response)'), old: { file: 'a', pointer: '/c/Pet/name' }, new: { file: 'b', pointer: '/c/Pet' } },
    change('request-parameter-removed', 'warning', 'GET', '/pets', 'Query parameter `q` removed'),
    change('request-parameter-deprecated', 'info', 'GET', '/pets', 'Query parameter `x` deprecated'),
    change('api-version-changed', 'info', undefined, undefined, 'API version changed from `1` to `2`'),
    { ...change('endpoint-added', 'info', 'GET', '/hidden', 'Endpoint added'), ignored: '' },
  ];
  const md = core.toMarkdown(cs, 'API changes: a → b');
  assert.equal(
    md,
    [
      '### API changes: a → b',
      '',
      '**3 breaking** · 1 possibly breaking · 2 other · 1 ignored',
      '',
      '#### Breaking changes',
      '',
      '- `DELETE /pets/{id}`: Endpoint removed',
      '- Response property `name` was removed (200 response), on `GET /pets`, `GET /pets/{id}`',
      '',
      '#### Possibly breaking',
      '',
      '- `GET /pets`: Query parameter `q` removed',
      '',
      '#### Other changes',
      '',
      '- `GET /pets`: Query parameter `x` deprecated',
      '- `Whole API`: API version changed from `1` to `2`',
      '',
    ].join('\n'),
  );
  assert.match(core.toMarkdown([], 'T'), /No changes for API consumers/);
});

test('view: groups by endpoint, whole API first, methods in order, breaking first', () => {
  const cs = [change('a', 'info', 'POST', '/b'), change('b', 'error', 'GET', '/b'), change('c', 'info'), change('d', 'warning', 'GET', '/a'), change('e', 'error', 'POST', '/b')];
  const g = model.groupChanges(cs);
  assert.deepEqual(
    g.map((x) => [x.key, x.items]),
    [
      ['', [2]],
      ['GET /a', [3]],
      ['GET /b', [1]],
      ['POST /b', [4, 0]],
    ],
  );
});

test('view: messages are escaped and backticks become code', () => {
  assert.equal(model.messageHtml('Property `<b>` & "x"'), 'Property <code>&lt;b&gt;</code> &amp; &quot;x&quot;');
  assert.ok(model.matchesQuery(change('response-property-removed', 'error', 'GET', '/pets', 'Response property `name` was removed'), 'pets name'));
  assert.ok(model.matchesQuery(change('server-added', 'info', undefined, undefined, 'Server added'), 'whole'));
  assert.ok(!model.matchesQuery(change('x', 'info', 'GET', '/a', 'm'), 'zzz'));
});

test('ignore rules match a moved endpoint by where it was as well as where it is', () => {
  const c = { ...change('endpoint-moved', 'error', 'GET', '/v2/pets', 'Endpoint moved'), movedFrom: { method: 'GET', path: '/internal/pets' } };
  assert.equal(core.applyPolicy([c], { ignore: [{ path: '/internal/**' }], warningsAsErrors: false })[0].ignored, '');
  assert.equal(core.applyPolicy([c], { ignore: [{ path: '/v2/**' }], warningsAsErrors: false })[0].ignored, '');
  assert.equal(core.applyPolicy([c], { ignore: [{ path: '/other/**' }], warningsAsErrors: false })[0].ignored, undefined);
  assert.ok(model.matchesQuery(c, 'internal'));
});

test('release notes: Breaking, Deprecated, Added, Changed, for consumers', () => {
  const cs = [
    change('endpoint-removed', 'error', 'DELETE', '/pets/{id}', 'Endpoint removed'),
    change('endpoint-deprecated', 'info', 'GET', '/pets', 'Endpoint deprecated'),
    change('response-property-deprecated', 'info', 'GET', '/pets', 'Response property `tag` was marked deprecated (200 response)'),
    change('endpoint-added', 'info', 'GET', '/stores', 'Endpoint added'),
    change('request-parameter-added', 'info', 'GET', '/pets', 'Optional query parameter `q` added'),
    change('response-property-enum-value-added', 'warning', 'GET', '/pets', 'Response property `status` enum value `sold` added (200 response)'),
    change('request-property-max-length-increased', 'info', 'POST', '/pets', 'Request property `name` maxLength changed from 20 to 40 (request body)'),
    { ...change('webhook-added', 'info', 'POST', 'petAdopted', 'Webhook added'), webhook: true },
    { ...change('endpoint-removed', 'error', 'GET', '/hidden', 'Endpoint removed'), ignored: '' },
  ];
  const md = core.toReleaseNotes(cs, { from: '`v1.0.0`', to: 'the working copy', versions: { old: '1.4.0', new: '2.0.0' }, spec: 'openapi.yaml' });
  assert.equal(
    md,
    [
      '## API 2.0.0',
      '',
      'Changes since `v1.0.0` (API 1.4.0), in `openapi.yaml`. 1 breaking change, 2 deprecations, 3 additions, 2 other changes.',
      '',
      '### Breaking changes',
      '',
      '- `DELETE /pets/{id}`: Endpoint removed',
      '',
      '### Deprecated',
      '',
      '- `GET /pets`',
      '  - Endpoint deprecated',
      '  - Response property `tag` was marked deprecated (200 response)',
      '',
      '### Added',
      '',
      '- `GET /stores`: Endpoint added',
      '- `GET /pets`: Optional query parameter `q` added',
      '- `POST petAdopted (webhook)`: Webhook added',
      '',
      '### Changed',
      '',
      '- `GET /pets`: Response property `status` enum value `sold` added (200 response) _(may break some clients)_',
      '- `POST /pets`: Request property `name` maxLength changed from 20 to 40 (request body)',
      '',
    ].join('\n'),
  );
  assert.match(core.toReleaseNotes([], { from: 'a', to: 'b' }), /^## API changes in b\n\nChanges since a\.\n\nNo changes for API consumers\.\n$/);
  assert.equal(core.releaseSection({ id: 'webhook-deprecated', level: 'info' }), 'deprecated');
  assert.equal(core.releaseSection({ id: 'response-status-added', level: 'info' }), 'added');
  assert.equal(core.releaseSection({ id: 'response-property-enum-value-added', level: 'warning' }), 'changed');
});

test('view: webhooks group after paths, by name', () => {
  const cs = [{ ...change('webhook-added', 'info', 'POST', 'zeta'), webhook: true }, change('b', 'error', 'GET', '/b'), change('c', 'info')];
  assert.deepEqual(
    model.groupChanges(cs).map((g) => [g.key, g.webhook ?? false]),
    [
      ['', false],
      ['GET /b', false],
      ['webhook POST zeta', true],
    ],
  );
});

test('Markdown: a shared schema change that reads differently per endpoint is listed once, by the schema', async () => {
  const read = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
  const r = await diff(read('petstore-v1.yaml'), read('petstore-v2.yaml'));
  const md = core.toMarkdown(r.changes, 'T');
  assert.ok(md.includes('- Response property `Pet.status` became optional: it may be left out, on `GET /pets`, `POST /pets`, `GET /pets/{id}`'), md);
  assert.ok(md.includes('- Response schema `PetStatus` enum value `adopted` added, on `GET /pets`, `POST /pets`, `GET /pets/{id}`'), md);
  // The parameter that uses PetStatus too is a different change: listed on its own.
  assert.ok(md.includes('Query parameter `status`: enum value `adopted` added'), md);
  assert.equal(core.schemaPropertyName({ file: '/a/models/owner.yaml', pointer: '/properties/email' }), 'owner.email');
  assert.equal(core.schemaPropertyName({ file: '/a/s.json', pointer: '/definitions/Pet/properties/tags/items/properties/name/maxLength' }), 'Pet.tags[].name');
  assert.equal(core.schemaPropertyName({ file: '/a/s.json', pointer: '/paths/~1x/get/responses/200' }), undefined);
});

test('a full comparison of the sample specs', async () => {
  const read = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
  const r = await diff(read('petstore-v1.yaml'), read('petstore-v2.yaml'));
  assert.deepEqual(r.errors, {});
  const n = core.count(r.changes);
  assert.ok(n.error >= 6 && n.warning >= 10 && n.info >= 8, JSON.stringify(n));
  assert.ok(ids(r).includes('error:endpoint-removed'));
});

test('the README lists every change id with its level', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // The tables are generated from the catalog: levels and summaries, not only the ids.
  const { tables } = await import('../scripts/rules-table.mjs');
  assert.ok(readme.includes(tables()), 'README tables differ from `node scripts/rules-table.mjs`');
  // And every id is there, or its schema rule, or the rule it is based on in a callback or webhook.
  const missing = core.allRules().filter((r) => {
    const id = r.base ?? r.id;
    const rule = r.schemaRule;
    return !readme.includes(`\`${id}\``) && !(rule && readme.includes(`\`…-${rule}\``));
  });
  assert.deepEqual(
    missing.map((r) => r.id),
    [],
  );
});

test('two files: which is the old one, from info.version, then the names; nothing said, no guess', () => {
  const t = (v) => `openapi: 3.0.0\ninfo: {title: t${v ? `, version: "${v}"` : ''}}\npaths: {}\n`;
  const order = (a, b, va, vb) => core.guessOrder({ name: a, text: t(va) }, { name: b, text: t(vb) })?.old;
  // The names that sorting got backwards.
  assert.equal(order('petstore.yaml', 'petstore-v2.yaml'), 0);
  assert.equal(order('petstore-v2.yaml', 'petstore.yaml'), 1);
  assert.equal(order('api-new.yaml', 'api-old.yaml'), 1);
  assert.equal(order('after.yaml', 'before.yaml'), 1);
  assert.equal(order('spec-v10.yaml', 'spec-v9.yaml'), 1);
  assert.equal(order('api.2024-05-01.json', 'api.2023-12-01.json'), 1);
  // info.version wins over the names.
  assert.equal(order('a-new.yaml', 'b-old.yaml', '2.0.0', '1.10.0'), 1);
  assert.equal(order('x.yaml', 'y.yaml', '1.9', '1.10'), 0);
  // Nothing to go by: undefined, and the extension asks.
  assert.equal(order('openapi.yaml', 'contract.json'), undefined);
  assert.equal(order('database.yaml', 'todo.yaml'), undefined);
});

test('view: code spans pair by fence length', () => {
  assert.equal(model.messageHtml('value `` a`b `` removed'), 'value <code>a`b</code> removed');
  assert.equal(model.messageHtml('`a` and `b`'), '<code>a</code> and <code>b</code>');
});
