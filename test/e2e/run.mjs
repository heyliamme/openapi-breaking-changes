// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// workspace holding a spec in a git repository (released as v0.9.0 and v1.0.0, changed
// since), and uses the extension the way a person would: shortcuts, menus (the Explorer's
// too), quick picks, git, the diff editor, the report's controls, release notes and the
// Problems panel. Then it opens a copy of the workspace again, untrusted, to check
// Restricted Mode. Linux, with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [openapi-breaking-changes-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'openapi-breaking-changes-e2e-')));
const ws = path.join(root, 'petstore');
const out = path.join(root, 'shots');
mkdirSync(path.join(ws, 'api', 'models'), { recursive: true });
mkdirSync(out);

// The sample specs, with the Owner schema moved to a file of its own so that references
// across files are read at the right version too.
const split = (text) => {
  const i = text.indexOf('    Owner:\n');
  return text.slice(0, i).replace("$ref: '#/components/schemas/Owner'", "$ref: './models/owner.yaml'");
};
const owner = (withEmail) =>
  ['type: object', 'properties:', '  name:', '    type: string', ...(withEmail ? ['  email:', '    type: string'] : []), '  pets:', '    type: array', '    items:', "      $ref: '../openapi.yaml#/components/schemas/Pet'", ''].join('\n');
const v1 = split(readFileSync('samples/petstore-v1.yaml', 'utf8'));
const v2 = split(readFileSync('samples/petstore-v2.yaml', 'utf8'));
const spec = path.join(ws, 'api', 'openapi.yaml');
writeFileSync(spec, v1);
writeFileSync(path.join(ws, 'api', 'models', 'owner.yaml'), owner(true));
writeFileSync(path.join(ws, 'api', 'broken.yaml'), 'openapi: 3.0.3\ninfo: {title: B, version: "1"}\npaths: {}\n');
writeFileSync(path.join(ws, 'notes.yaml'), 'name: not a spec\nitems: [1, 2]\n');
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
git('init', '-q');
// An older release without /stores, to write release notes between two tags.
const v09 = v1.replace(/\n  \/stores:\n[\s\S]*?(?=\n  \/|\n[a-z])/, '').replace('version: 1.4.0', 'version: 1.3.0');
writeFileSync(spec, v09);
git('add', '.');
git('commit', '-qm', 'Petstore 1.3');
git('tag', 'v0.9.0');
writeFileSync(spec, v1);
git('add', '.');
git('commit', '-qm', 'Petstore 1.4');
git('tag', 'v1.0.0');
git('branch', 'release/1.x');
// Since the release: version 2 in the working copy, not committed.
writeFileSync(spec, v2);
writeFileSync(path.join(ws, 'api', 'models', 'owner.yaml'), owner(false));
writeFileSync(path.join(ws, 'api', 'broken.yaml'), 'openapi: 3.0.3\ninfo: {title: B, version: "1"}\npaths:\n  /a: [\n');
// Another copy of the spec, named like anything else, in JSON: found by content.
const contract = JSON.stringify({ openapi: '3.0.3', info: { title: 'Petstore', version: '1.4.0' }, paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } } }, null, 2);
writeFileSync(path.join(ws, 'api', 'contract.json'), contract);
// Pairs for the Explorer: told apart by their names (the same info.version), and not at all.
const sameVersion = (t) => t.replace(/^  version: .*$/m, '  version: 1.0.0');
const explorerFiles = (dir) => {
  writeFileSync(path.join(dir, 'petstore.yaml'), sameVersion(readFileSync('samples/petstore-v1.yaml', 'utf8')));
  writeFileSync(path.join(dir, 'petstore-v2.yaml'), sameVersion(readFileSync('samples/petstore-v2.yaml', 'utf8')));
  writeFileSync(path.join(dir, 'left.yaml'), sameVersion(readFileSync('samples/petstore-v1.yaml', 'utf8')));
  writeFileSync(path.join(dir, 'right.yaml'), sameVersion(readFileSync('samples/petstore-v2.yaml', 'utf8')));
};
explorerFiles(ws);

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'git.openRepositoryInParentFolders': 'never',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'editor.autoClosingQuotes': 'never',
  'editor.autoClosingBrackets': 'never',
  'editor.formatOnType': false,
  'editor.autoIndent': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'redhat.telemetry.enabled': false,
  // Menus in the page, so the Explorer's context menu can be clicked; a click only selects.
  'window.menuStyle': 'custom',
  'workbench.list.openMode': 'doubleClick',
};
let vs = new VSCode(root);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// In the webview.
const W = {
  counts: `Object.fromEntries([...document.querySelectorAll('.chip')].map((c) => [c.dataset.level, +c.querySelector('b').textContent]))`,
  sides: `[...document.querySelectorAll('#sides .label')].map((e) => e.textContent)`,
  rows: `document.querySelectorAll('.change').length`,
  groups: `[...document.querySelectorAll('.group .ghead')].map((g) => g.querySelector('.path').textContent)`,
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  row: (text) => `[...document.querySelectorAll('.change')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`,
};
let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });

/** Moves keyboard focus out of a webview, back to the workbench. */
async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.sidebar .composite.title')`);
}
async function openFile(name) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('p', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
  await vs.type(name);
  await sleep(700);
  await vs.key('Enter');
  const base = name.split('/').pop();
  await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith(base)), { what: `${name} to open` });
  await sleep(400);
  await focusEditor();
}
/** A real click into the active text editor, so typing and shortcuts land there. */
async function focusEditor() {
  await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-instance .monaco-editor .view-lines')`);
  await sleep(150);
}
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await focusWorkbench();
  await vs.key('k', { ctrl: true });
  await vs.key('w', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
async function chord(key, mods = {}) {
  await vs.key('k', { ctrl: true });
  await vs.key(key, mods);
}
/** Runs a command that opens a quick pick or input of its own: doesn't wait for it to close. */
async function paletteRun(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'quick input to close' });
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await sleep(600);
}
async function goToLine(n) {
  await vs.key('g', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'go to line' });
  await vs.type(String(n));
  await sleep(200);
  await vs.key('Enter');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'go to line to close' });
  await sleep(300);
}
/** Errors and warnings in the status bar. */
async function problemCounts() {
  const t = await vs.eval(`document.querySelector('[id="status.problems"]')?.textContent ?? ''`);
  const [errors = 0, warnings = 0] = (t.match(/\d+/g) ?? []).map(Number);
  return { errors, warnings };
}
async function statusBarSelection() {
  return vs.eval(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
}
async function setClipboard(text) {
  // Through an untitled editor, as a user would: VS Code's own clipboard, not the page's.
  await newUntitled();
  await vs.type(text);
  await vs.key('a', { ctrl: true });
  await vs.key('c', { ctrl: true });
  await sleep(200);
  await vs.command('View: Revert and Close Editor');
}
async function newUntitled() {
  await focusWorkbench();
  await vs.key('n', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).some((t) => /^Untitled-\d+$/.test(t)), { what: 'untitled editor' });
  await sleep(300);
}
async function editorText() {
  return vs.eval(`[...document.querySelectorAll('.editor-group-container.active .editor-instance .view-lines .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join('\\n').replace(/\\u00a0/g, ' ')`);
}
async function quickItems() {
  return vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map((r) => (r.getAttribute('aria-label') || r.textContent).trim())`);
}
async function writeWorkspaceSettings(obj) {
  mkdirSync(path.join(ws, '.vscode'), { recursive: true });
  writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify(obj, null, 2));
}
async function reportTab() {
  await vs.showTab('API changes');
}
/** Selects two files at the top of the Explorer and runs Compare Specs from its context menu. */
async function explorerCompare(a, b) {
  await vs.command('View: Show Explorer');
  const row = (n) => `[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((r) => r.textContent.trim() === ${JSON.stringify(n)})`;
  await waitFor(() => vs.eval(`!!${row(a)} && !!${row(b)}`), { what: `${a} and ${b} in the Explorer` });
  await vs.clickElement(row(a));
  const box = await vs.eval(`(() => { const r = ${row(b)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await vs.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 2 });
  await waitFor(async () => (await vs.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row.selected')].length`)) === 2, { what: 'two files selected' });
  await vs.clickElement(row(b), 'right');
  const item = `[...document.querySelectorAll('.context-view .action-item')].find((x) => x.textContent.includes('Compare Specs for Breaking Changes'))`;
  await waitFor(() => vs.eval(`!!${item}`), { what: 'Compare Specs in the context menu' });
  await vs.clickElement(item);
}

try {
  console.log(`VS Code profile: ${root}`);
  await vs.launch(ws);
  await sleep(2000);

  await step('Ctrl+K B on a spec offers branches and tags, and compares with the pick', async () => {
    await openFile('api/openapi.yaml');
    await chord('b');
    await waitFor(() => vs.quickInputVisible(), { what: 'ref picker' });
    await waitFor(async () => (await quickItems()).some((i) => i.includes('v1.0.0')), { what: 'tags in the picker' });
    const items = await quickItems();
    ok(items.some((i) => i.includes('release/1.x')), `branches listed: ${items.join(' | ')}`);
    ok(items.some((i) => i.includes('HEAD')), 'HEAD listed');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
    eq(await w(W.sides), ['openapi.yaml (v1.0.0)', 'openapi.yaml'], 'sides');
    await until(`document.querySelectorAll('.change').length > 0`, 'changes');
    const counts = await w(W.counts);
    ok(counts.error >= 8 && counts.warning >= 14 && counts.info >= 10, `counts: ${JSON.stringify(counts)}`);
    ok((await vs.editorTabs()).some((t) => t.includes('API changes: openapi.yaml (v1.0.0) → openapi.yaml')), 'panel title');
  });

  await step('the report groups changes by endpoint, whole API first', async () => {
    const groups = await w(W.groups);
    eq(groups[0], 'Whole API', 'first group');
    ok(groups.includes('/pets/{id}') && groups.includes('/stores'), `groups: ${groups.join(', ')}`);
    ok(await w(`!!document.querySelector('.method.m-delete')`), 'method badge');
  });

  await step('a schema in another file is read at the same version', async () => {
    // owner.yaml lost `email` since v1.0.0; v1.0.0's copy was read from git, not the disk.
    const row = await w(`${W.row('owner.email')}?.textContent ?? ''`);
    ok(row.includes('response-property-removed'), `owner.email row: ${row}`);
    ok(/old owner\.yaml:\d+/.test(row), `points into owner.yaml: ${row}`);
  });

  await step('a moved endpoint is one breaking change that says where it was', async () => {
    const row = await w(`${W.row('Endpoint moved')}?.textContent ?? ''`);
    ok(row.includes('endpoint-moved') && row.includes('GET /pets/{petId}/photos') && row.includes('same operationId listPetPhotos'), `moved row: ${row}`);
    ok(await w(`[...document.querySelectorAll('.ghead .from')].some((e) => e.textContent === 'was GET /pets/{petId}/photos')`), 'the group says where it was');
    ok(!(await w(`[...document.querySelectorAll('.group')].some((g) => g.dataset.key.includes('/photos'))`)), 'not also a removed endpoint');
  });

  await step('webhooks and callbacks are compared, judged from the receiving end', async () => {
    ok(await w(`[...document.querySelectorAll('.group')].some((g) => g.querySelector('.kind')?.textContent === 'webhook' && g.textContent.includes('petAdopted') && g.textContent.includes('webhook-added'))`), 'webhook group');
    const row = await w(`${W.row('payload property adoptedAt')}?.textContent ?? ''`);
    ok(row.includes('callback-request-property-became-optional') && row.includes('Callback adopted (POST {$request.body#/callbackUrl}): payload property adoptedAt became optional'), `callback row: ${row}`);
    ok(await w(`${W.row('payload property adoptedAt')}.classList.contains('error')`), 'breaking: clients read it');
  });

  await step('screen readers: a status line instead of a live list, labelled counts, focus kept', async () => {
    ok(await w(`!document.querySelector('[aria-live]:not(#status)')`), 'no live region around the list');
    const status = await w(`document.getElementById('status').textContent`);
    ok(/^\d+ of \d+ changes shown, on \d+ endpoints$/.test(status), `status: ${status}`);
    ok(await w(`[...document.querySelectorAll('.ghead')].some((g) => /\\d+ breaking,/.test(g.textContent))`), 'counts say what they count');
    await w(`(() => { const c = document.querySelector('.chip.info'); c.focus(); c.click(); })()`);
    eq(await w(`document.activeElement?.dataset?.level`), 'info', 'focus on the chip after hiding');
    await until(`/^\\d+ of \\d+ changes shown/.test(document.getElementById('status').textContent)`, 'status updated');
    await w(`document.activeElement.click()`);
    eq(await w(`document.activeElement?.dataset?.level`), 'info', 'focus on the chip after showing');
  });

  if (shotsFor) {
    mkdirSync(shotsFor, { recursive: true });
    await w(`window.scrollTo(0, 0)`);
    await sleep(400);
    await shotOfEditor(path.join(shotsFor, 'report-dark.png'));
  }

  await step('level chips hide and show levels', async () => {
    const before = await w(W.rows);
    await w(W.click('.chip.info'));
    const after = await w(W.rows);
    ok(after < before, `rows ${before} → ${after}`);
    ok(!(await w(`[...document.querySelectorAll('.change')].some((r) => r.classList.contains('info'))`)), 'no info rows');
    eq(await w(`document.querySelector('.chip.info').getAttribute('aria-pressed')`), 'false', 'pressed state');
    await w(W.click('.chip.info'));
    eq(await w(W.rows), before, 'all back');
  });

  await step('search filters by path, id or text', async () => {
    await w(`(() => { const s = document.getElementById('search'); s.value = 'x-tenant'; s.dispatchEvent(new Event('input')); })()`);
    await until(`document.querySelectorAll('.change').length === 1`, 'one match');
    ok(await w(`${W.row('X-Tenant')}.textContent.includes('request-parameter-added-required')`), 'the match');
    await w(`(() => { const s = document.getElementById('search'); s.value = 'nothing-like-this'; s.dispatchEvent(new Event('input')); })()`);
    await until(`!!document.getElementById('clearFilter')`, 'empty state');
    await w(W.click('#clearFilter'));
    await until(`document.querySelectorAll('.change').length > 10`, 'filter cleared');
    eq(await w(`document.activeElement?.id`), 'search', 'focus on the search box, not lost');
  });

  await step('groups collapse and expand', async () => {
    await w(`[...document.querySelectorAll('.ghead')].find((g) => g.textContent.includes('/stores')).click()`);
    ok(await w(`document.querySelector('.group[data-key="GET /stores"]').classList.contains('collapsed')`), 'collapsed');
    await w(`document.querySelector('.group[data-key="GET /stores"] .ghead').click()`);
    ok(await w(`!document.querySelector('.group[data-key="GET /stores"]').classList.contains('collapsed')`), 'expanded');
  });

  await step('keyboard: one tab stop for the rows, arrows reach every header, folded ones too', async () => {
    eq(await w(`document.querySelectorAll('.change[tabindex="0"]').length`), 1, 'rows in the tab order');
    eq(await w(`[...document.querySelectorAll('.change[tabindex="-1"] button')].filter((b) => b.tabIndex !== -1).length`), 0, "other rows' buttons out of the tab order");
    await w(`[...document.querySelectorAll('.ghead')].find((g) => g.textContent.includes('/stores')).click()`);
    const key = (k) => `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`;
    // The last row before the folded group, then down: its header.
    await w(`(() => { const g = document.querySelector('.group[data-key="GET /stores"]'); let p = g.previousElementSibling; const rows = p.querySelectorAll('.change'); rows[rows.length - 1].focus(); })()`);
    eq(await w(`document.activeElement.tabIndex`), 0, 'the focused row is the tab stop');
    await w(key('ArrowDown'));
    ok(await w(`document.activeElement === document.querySelector('.group[data-key="GET /stores"] .ghead')`), 'ArrowDown lands on the folded header');
    await w(`document.activeElement.click()`);
    ok(await w(`!document.querySelector('.group[data-key="GET /stores"]').classList.contains('collapsed')`), 'opened from the keyboard');
    await w(key('ArrowDown'));
    ok(await w(`document.activeElement.closest('.group')?.dataset.key === 'GET /stores' && document.activeElement.classList.contains('change')`), 'then its first row');
  });

  await step('clicking a change opens the new spec at its line', async () => {
    const line = await w(`(() => { const r = ${W.row('X-Tenant')}; return r.querySelector('.loc.new').textContent; })()`);
    await w(`${W.row('X-Tenant')}.querySelector('.msg').click()`);
    const n = line.match(/(\d+)$/)[1];
    await waitFor(async () => (await statusBarSelection()).includes(`Ln ${n},`), { what: `cursor on line ${n}` });
    await reportTab();
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
  });

  await step('the old side opens the file as of the ref', async () => {
    await w(`${W.row('Endpoint removed')}.querySelector('.loc.old').click()`);
    await waitFor(async () => (await vs.editorTabs()).some((t) => /openapi\.yaml.*v1\.0\.0/.test(t)), { what: 'openapi.yaml at v1.0.0' });
    await waitFor(async () => /Ln \d+,/.test(await statusBarSelection()), { what: 'cursor' });
    await reportTab();
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
  });

  await step('Copy as Markdown puts a changelog on the clipboard', async () => {
    await w(W.click('#copy'));
    await sleep(400);
    await newUntitled();
    try {
      await vs.key('v', { ctrl: true });
      await sleep(400);
      await vs.key('Home', { ctrl: true });
      await sleep(300);
      const md = await editorText();
      ok(md.startsWith('### API changes: openapi.yaml (v1.0.0) → openapi.yaml'), md.slice(0, 200));
      ok(md.includes('#### Breaking changes'), 'breaking heading');
      ok(md.includes('- `DELETE /pets/{id}`: Endpoint removed'), `removed endpoint line: ${md.slice(0, 1500)}`);
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
    await reportTab();
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
  });

  await step('Release Notes in the report opens release notes for consumers', async () => {
    await w(W.click('#releaseNotes'));
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('## API')), { what: 'release notes editor' });
    try {
      await sleep(600);
      const md = await editorText();
      ok(md.startsWith('## API 2.0.0'), md.slice(0, 300));
      ok(md.includes('Changes since `v1.0.0` (API 1.4.0)') && md.includes('### Breaking changes') && md.includes('Endpoint moved'), md.slice(0, 1200));
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
    await reportTab();
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
  });

  await step('Ignore… writes a rule to the workspace settings and the report dims the change', async () => {
    const before = await w(W.counts);
    await w(`${W.row('enum value adopted added (200 response)')}.querySelector('.ign').click()`);
    await waitFor(() => vs.quickInputVisible(), { what: 'ignore picker' });
    await vs.pickQuickItem('Every response-property-enum-value-added');
    const file = path.join(ws, '.vscode', 'settings.json');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('response-property-enum-value-added'), { what: 'workspace settings' });
    await until(`(${W.counts}).ignored > 0`, 'ignored count');
    const after = await w(W.counts);
    ok(after.warning < before.warning, `warnings ${before.warning} → ${after.warning}`);
    ok(await w(`!!document.querySelector('.change.is-ignored')`), 'dimmed row');
    ok(await w(`document.querySelector('.change.is-ignored').getAttribute('aria-label').startsWith('possibly breaking, ignored:')`), 'announced as ignored');
    await w(W.click('.chip.ignored'));
    ok(!(await w(`!!document.querySelector('.change.is-ignored')`)), 'ignored hidden');
    await w(W.click('.chip.ignored'));
  });

  await step('warnings as errors moves warnings into breaking', async () => {
    const before = await w(W.counts);
    const file = path.join(ws, '.vscode', 'settings.json');
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    await writeWorkspaceSettings({ ...cur, 'openapiBreakingChanges.treatWarningsAsErrors': true });
    await until(`(${W.counts}).warning === 0`, 'no warnings left');
    eq((await w(W.counts)).error, before.error + before.warning, 'errors include warnings');
    ok(await w(`document.querySelector('.summary .note')?.textContent.includes('Warnings count as breaking')`), 'note');
    await writeWorkspaceSettings({});
    await until(`(${W.counts}).warning > 0 && !(${W.counts}).ignored`, 'settings cleared');
  });

  await step('detectMovedEndpoints off: a moved endpoint is removed and added again', async () => {
    await writeWorkspaceSettings({ 'openapiBreakingChanges.detectMovedEndpoints': 'off' });
    await until(`!${W.row('Endpoint moved')} && [...document.querySelectorAll('.group')].some((g) => g.dataset.key === 'GET /pets/{petId}/photos' && g.textContent.includes('endpoint-removed'))`, 'removed and added');
    await writeWorkspaceSettings({});
    await until(`!!${W.row('Endpoint moved')}`, 'moved again');
  });

  await step('the report follows edits to the spec', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await chord('b');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
    await until(`(${W.counts}).error > 0`, 'report');
    const before = (await w(W.counts)).error;
    await openFile('api/openapi.yaml');
    try {
      // A new required query parameter on GET /pets, typed into the editor.
      const lines = readFileSync(spec, 'utf8').split('\n');
      // Pasted, so the editor doesn't indent it.
      await setClipboard('        - { name: region, in: query, required: true, schema: { type: string } }\n');
      await openFile('api/openapi.yaml');
      await goToLine(`${lines.findIndex((l) => l.includes('- name: X-Tenant')) + 1}:1`);
      await vs.key('v', { ctrl: true });
      await sleep(300);
      await vs.screenshot(path.join(out, 'edit-typed.png'));
      await reportTab();
      ctx = await vs.webview('openapi.yaml (v1.0.0)');
      await until(`(${W.counts}).error === ${before + 1}`, 'one more breaking change', 8000).catch(async (e) => {
        throw new Error(`${e.message}; counts ${JSON.stringify(await w(W.counts))}, before ${before}, notes: ${await w(`document.getElementById('cards').textContent`)}`);
      });
      ok(await w(`!!${W.row('Required query parameter region added')}`), 'the new change');
    } finally {
      await openFile('api/openapi.yaml');
      await vs.command('File: Revert File');
    }
    await reportTab();
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
    await until(`(${W.counts}).error === ${before}`, 'back after revert', 8000);
  });

  await step('swap turns the comparison around', async () => {
    await w(W.click('#swap'));
    await until(`${W.sides}[0] === 'openapi.yaml'`, 'swapped');
    ok((await w(W.counts)).error > 0, 'still has changes');
    await w(W.click('#swap'));
    await until(`${W.sides}[0] === 'openapi.yaml (v1.0.0)'`, 'swapped back');
  });

  await step('Compare with HEAD from the Command Palette', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await vs.command('OpenAPI Breaking Changes: Compare with HEAD');
    ctx = await vs.webview('openapi.yaml (HEAD)');
    await until(`document.querySelectorAll('.change').length > 0`, 'changes');
  });

  await step('files that are not specs: no shortcut and no commands for them', async () => {
    await closeAll();
    await openFile('notes.yaml');
    await chord('b');
    await sleep(1200);
    ok(!(await vs.quickInputVisible()), 'the shortcut does nothing on a plain YAML file');
    await vs.key('F1');
    await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
    await vs.type('OpenAPI Breaking Changes: Compare with');
    await sleep(700);
    const items = await quickItems();
    await vs.key('Escape');
    ok(!items.some((i) => /Compare with (HEAD|Git Branch|Another Spec)/.test(i)), `palette: ${items.join(' | ')}`);
  });

  await step('Explorer: two specs, the old one told by the names', async () => {
    await closeAll();
    await explorerCompare('petstore-v2.yaml', 'petstore.yaml');
    ctx = await vs.webview('petstore.yaml');
    eq(await w(W.sides), ['petstore.yaml', 'petstore-v2.yaml'], 'old, then new');
    await until(`(${W.counts}).error > 0`, 'breaking changes');
  });

  await step('Explorer: when nothing says which is older, it asks', async () => {
    await closeAll();
    await explorerCompare('left.yaml', 'right.yaml');
    await waitFor(async () => (await vs.eval(`document.querySelector('.quick-input-widget .quick-input-title')?.textContent ?? ''`)).includes('Which is the old version?'), { what: 'which is older' });
    await vs.pickQuickItem('right.yaml');
    ctx = await vs.webview('right.yaml');
    eq(await w(W.sides), ['right.yaml', 'left.yaml'], 'as picked');
  });

  await step('Explorer: a file that is not a spec gets a clear message', async () => {
    await closeAll();
    await explorerCompare('notes.yaml', 'petstore.yaml');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes("doesn't look like an OpenAPI")), { what: 'not a spec message' });
    await vs.clearNotifications();
  });

  await step('Compare with Another Spec finds specs by content', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await paletteRun('OpenAPI Breaking Changes: Compare with Another Spec');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('contract.json')), { what: 'contract.json listed' });
    const items = await quickItems();
    ok(!items.some((i) => i.includes('notes.yaml')), `plain YAML not listed: ${items.join(' | ')}`);
    await vs.pickQuickItem('contract.json');
    ctx = await vs.webview('contract.json');
    eq(await w(W.sides), ['contract.json', 'openapi.yaml'], 'sides');
    ok((await w(W.counts)).info > 0, 'changes');
  });

  await step('a spec that does not parse says where', async () => {
    await closeAll();
    await openFile('api/broken.yaml');
    await vs.command('OpenAPI Breaking Changes: Compare with HEAD');
    ctx = await vs.webview('broken.yaml (HEAD)');
    await until(`!!document.querySelector('.card.error')`, 'error card');
    const text = await w(`document.querySelector('.card.error').textContent`);
    ok(text.includes("Couldn't read the new spec") && /line \d+/.test(text), text);
    ok(await w(`document.getElementById('copy').disabled && document.getElementById('releaseNotes').disabled`), 'nothing to copy');
    await w(W.click('.card.error .open-error'));
    await waitFor(async () => /Ln \d+,/.test(await statusBarSelection()), { what: 'cursor at the error' });
  });

  await step('the diff editor title button checks a Source Control diff', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`);
    await waitFor(async () => await vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(800);
    const btn = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Check This Diff for Breaking Changes"]')`;
    await waitFor(() => vs.eval(`!!${btn}`), { what: 'title button' });
    await vs.clickElement(btn);
    ctx = await vs.webview('openapi.yaml (index)');
    eq(await w(W.sides), ['openapi.yaml (index)', 'openapi.yaml'], 'sides');
    await until(`(${W.counts}).error > 0`, 'breaking changes');
  });

  await step('Ctrl+K B in a diff editor does the same', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`);
    await waitFor(async () => await vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(800);
    await vs.clickElement(`document.querySelector('.editor-group-container.active .monaco-diff-editor .editor.modified .view-lines')`);
    await chord('b');
    ctx = await vs.webview('openapi.yaml (index)');
  });

  await step('Write Release Notes… from the latest tag to the working copy', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await paletteRun('OpenAPI Breaking Changes: Write Release Notes');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('latest tag')), { what: 'latest tag offered' });
    const items = await quickItems();
    ok(items[0].includes('v1.0.0') && items[0].includes('latest tag'), `first: ${items[0]}`);
    ok(items.findIndex((i) => i.includes('v1.0.0') && !i.includes('latest')) < 0, 'not listed twice');
    await vs.pickQuickItem('latest tag');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('Working copy')), { what: 'the new side' });
    await vs.pickQuickItem('Working copy');
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('## API')), { what: 'release notes editor' });
    try {
      await sleep(600);
      const md = await editorText();
      ok(md.startsWith('## API 2.0.0\n\nChanges since `v1.0.0` (API 1.4.0), in `openapi.yaml`.'), md.slice(0, 300));
      ok(md.includes('### Breaking changes') && md.includes('`DELETE /pets/{id}`: Endpoint removed'), md.slice(0, 1500));
      if (shotsFor) {
        await vs.command('Markdown: Open Preview to the Side');
        await sleep(2500);
        await shotOfEditor(path.join(shotsFor, 'release-notes-dark.png'));
        await vs.command('View: Close Editor');
      }
    } finally {
      await vs.showTab('## API');
      await vs.command('View: Revert and Close Editor');
    }
  });

  await step('Write Release Notes… between two tags', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await paletteRun('OpenAPI Breaking Changes: Write Release Notes');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('v0.9.0')), { what: 'tags' });
    await vs.pickQuickItem('v0.9.0');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('Working copy')), { what: 'the new side' });
    await waitFor(async () => (await quickItems()).some((i) => i.includes('v1.0.0')), { what: 'tags on the new side' });
    ok(!(await quickItems()).some((i) => i.includes('v0.9.0')), 'the old side is not offered again');
    await vs.pickQuickItem('v1.0.0');
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('## API')), { what: 'release notes editor' });
    await sleep(600);
    const md = await editorText();
    try {
      ok(md.startsWith('## API 1.4.0\n\nChanges since `v0.9.0` (API 1.3.0), in `openapi.yaml`. 1 addition, 1 other change.'), md.slice(0, 300));
      ok(md.includes('### Added') && md.includes('`GET /stores`: Endpoint added') && !md.includes('### Breaking'), md);
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
  });

  await step('baseRef puts breaking changes in the Problems panel', async () => {
    await closeAll();
    await writeWorkspaceSettings({ 'openapiBreakingChanges.baseRef': 'v1.0.0' });
    await openFile('api/openapi.yaml');
    await waitFor(async () => (await problemCounts()).errors > 0, { what: 'errors in the status bar', timeout: 15000 });
    await vs.command('View: Focus Problems (Errors, Warnings, Infos)');
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.markers-panel .monaco-list-row')].some((r) => r.textContent.includes('response-property-became-optional'))`), { what: 'problem rows' });
    const rows = await vs.eval(`[...document.querySelectorAll('.markers-panel .monaco-list-row')].map((r) => r.textContent)`);
    ok(rows.some((r) => r.includes('since v1.0.0')), `source shown: ${rows.slice(0, 3).join(' | ')}`);
    // A shared schema's change is one problem listing its endpoints.
    ok(rows.some((r) => r.includes('Response property') && r.includes('GET /pets') && r.includes('GET /pets/{id}')) || rows.some((r) => /endpoints/.test(r)), `grouped: ${rows.slice(0, 6).join(' | ')}`);
    if (shotsFor) {
      await openFile('api/openapi.yaml');
      const lines = readFileSync(spec, 'utf8').split('\n');
      await goToLine(lines.findIndex((l) => l.includes('- name: X-Tenant')) - 6);
      await vs.command('View: Focus Problems (Errors, Warnings, Infos)');
      await sleep(1200);
      await vs.screenshot(path.join(shotsFor, 'problems-dark.png'));
    }
  });

  await step('a breaking change in a referenced file is a problem in that file', async () => {
    // owner.yaml, which the spec references, lost `email` since v1.0.0.
    await openFile('api/models/owner.yaml');
    await waitFor(() => vs.eval(`!!document.querySelector('.editor-group-container.active .squiggly-warning, .editor-group-container.active .squiggly-error')`), { what: 'a problem underlined in owner.yaml', timeout: 15000 });
  });

  await step('the quick fix opens the report since the baseline', async () => {
    await openFile('api/openapi.yaml');
    const lines = readFileSync(spec, 'utf8').split('\n');
    await goToLine(lines.findIndex((l) => l.includes('- name: X-Tenant')) + 1);
    await vs.command('Quick Fix...');
    await waitFor(() => vs.eval(`!!document.querySelector('.action-widget')`), { what: 'quick fix menu' });
    const items = await vs.eval(`[...document.querySelectorAll('.action-widget .monaco-list-row')].map((r) => r.textContent)`);
    ok(items.some((t) => t.includes('Ignore request-parameter-added-required')), `items: ${items.join(' | ')}`);
    await vs.clickElement(`[...document.querySelectorAll('.action-widget .monaco-list-row')].find((r) => r.textContent.includes('Show all API changes'))`);
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
    await until(`(${W.counts}).error > 0`, 'report');
    await writeWorkspaceSettings({});
    await openFile('api/openapi.yaml');
    await waitFor(async () => (await problemCounts()).errors === 0, { what: 'problems cleared', timeout: 10000 });
  });

  await step('a baseRef that names nothing says so instead of showing no problems', async () => {
    await closeAll();
    await writeWorkspaceSettings({ 'openapiBreakingChanges.baseRef': 'v1.0.O' });
    await openFile('api/openapi.yaml');
    const toast = `[...document.querySelectorAll('.notification-list-item-message')].some((t) => t.textContent.includes('"v1.0.O" in openapiBreakingChanges.baseRef is not a branch, tag or commit'))`;
    await waitFor(() => vs.eval(toast), { what: 'a warning about the ref', timeout: 15000 });
    await vs.command('Notifications: Clear All Notifications');
    await writeWorkspaceSettings({});
  });

  if (shotsFor) {
    await step('light theme screenshot', async () => {
      await vs.command('View: Close Panel');
      await closeAll();
      await openFile('api/openapi.yaml');
      await chord('b');
      await vs.pickQuickItem('v1.0.0');
      ctx = await vs.webview('openapi.yaml (v1.0.0)');
      const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
      writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
      await sleep(2000);
      for (const l of ['warning', 'info']) await w(`(() => { const c = document.querySelector('.chip.${l}'); if (c.getAttribute('aria-pressed') === 'true') c.click(); })()`);
      await sleep(500);
      await shotOfEditor(path.join(shotsFor, 'report-light.png'));
      for (const l of ['warning', 'info']) await w(W.click(`.chip.${l}`));
      writeFileSync(userSettings, JSON.stringify(settings, null, 2));
      await sleep(1500);
    });
  }

  await step('the report comes back after Reload Window', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await chord('b');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('openapi.yaml (v1.0.0)');
    await w(W.click('.chip.info'));
    await sleep(300);
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('API changes')), { timeout: 20000, what: 'restored tab' });
    await reportTab();
    ctx = await vs.webview('openapi.yaml (v1.0.0)', 25000);
    await until(`(${W.counts}).error > 0`, 'restored report', 15000);
    eq(await w(`document.querySelector('.chip.info').getAttribute('aria-pressed')`), 'false', 'filter kept');
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });

  await vs.close();
  await restricted();
} finally {
  await vs.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}

/**
 * Restricted Mode: a copy of the workspace, never trusted, whose settings try to hide every
 * change and to run Git.
 */
async function restricted() {
  const r = path.join(root, 'restricted');
  const ws2 = path.join(r, 'petstore');
  mkdirSync(path.join(ws2, 'api'), { recursive: true });
  mkdirSync(path.join(ws2, '.vscode'), { recursive: true });
  writeFileSync(path.join(ws2, 'api', 'openapi.yaml'), readFileSync('samples/petstore-v1.yaml', 'utf8'));
  writeFileSync(path.join(ws2, 'api', 'contract.json'), contract);
  explorerFiles(ws2);
  const g = (...a) => execFileSync('git', a, { cwd: ws2, encoding: 'utf8' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'v1');
  writeFileSync(path.join(ws2, 'api', 'openapi.yaml'), readFileSync('samples/petstore-v2.yaml', 'utf8'));
  const workspaceSettings = { 'openapiBreakingChanges.ignore': ['*'], 'openapiBreakingChanges.baseRef': 'HEAD' };
  writeFileSync(path.join(ws2, '.vscode', 'settings.json'), JSON.stringify(workspaceSettings, null, 2));
  const trust = { ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never', 'security.workspace.trust.untrustedFiles': 'open' };
  vs = new VSCode(r);
  vs.install(vsix, trust);
  await vs.launch(ws2);
  await sleep(2500);
  const userSettings = path.join(r, 'user-data', 'User', 'settings.json');

  await step('Restricted Mode: the workspace baseline is not applied', async () => {
    ok(await vs.eval(`!!document.querySelector('[id="status.workspaceTrust"], .statusbar-item[aria-label*="Restricted Mode"]') || document.body.textContent.includes('Restricted Mode')`), 'the window is in Restricted Mode');
    await openFile('api/openapi.yaml');
    await sleep(4000);
    eq(await problemCounts(), { errors: 0, warnings: 0 }, 'problems');
  });

  await step('Restricted Mode: nothing that needs Git runs', async () => {
    await vs.command('OpenAPI Breaking Changes: Compare with HEAD');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes('needs a trusted workspace')), { what: 'trust message' });
    ok(!(await vs.editorTabs()).some((t) => t.includes('API changes')), 'no report');
    await vs.clearNotifications();
  });

  await step('Restricted Mode: two files compare, and the workspace ignore rules are not applied', async () => {
    await closeAll();
    await openFile('api/openapi.yaml');
    await paletteRun('OpenAPI Breaking Changes: Compare with Another Spec');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('contract.json')), { what: 'contract.json listed' });
    await vs.pickQuickItem('contract.json');
    ctx = await vs.webview('contract.json');
    await until(`(${W.counts}).info > 0`, 'changes');
    eq((await w(W.counts)).ignored, undefined, 'nothing ignored (no ignored chip)');
  });

  await step('Restricted Mode: Ignore offers the user settings instead', async () => {
    await w(`document.querySelector('.change .ign').click()`);
    await waitFor(() => vs.quickInputVisible(), { what: 'ignore picker' });
    await vs.pickQuickItem('Every ');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes('Restricted Mode')), { what: 'restricted mode message' });
    await vs.dialogButton('Add to User Settings');
    await waitFor(() => /openapiBreakingChanges\.ignore/.test(readFileSync(userSettings, 'utf8')), { what: 'user settings' });
    eq(JSON.parse(readFileSync(path.join(ws2, '.vscode', 'settings.json'), 'utf8')), workspaceSettings, 'workspace settings untouched');
    await reportTab();
    ctx = await vs.webview('contract.json');
    await until(`(${W.counts}).ignored > 0`, 'ignored now');
  });

  await step('Restricted Mode: the Explorer compare works', async () => {
    await closeAll();
    await explorerCompare('petstore-v2.yaml', 'petstore.yaml');
    ctx = await vs.webview('petstore.yaml');
    eq(await w(W.sides), ['petstore.yaml', 'petstore-v2.yaml'], 'old, then new');
    await until(`(${W.counts}).error > 0`, 'breaking changes');
  });

  await step('Restricted Mode: no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
}
