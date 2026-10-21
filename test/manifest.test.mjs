// The extension manifest and what the package ships.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { core } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const settings = pkg.contributes.configuration.properties;

test('change ids given as examples in the settings exist', () => {
  const known = new Set(core.allRules().map((r) => r.id));
  const text = JSON.stringify(settings);
  const examples = [...text.matchAll(/`((?:request|response|endpoint|operation|security|server|webhook|callback)[a-z-]*)`/g)].map((m) => m[1]);
  assert.ok(examples.length > 0);
  assert.deepEqual(
    examples.filter((id) => !known.has(id)),
    [],
  );
});

test('settings are read per folder, so a multi-root workspace can set them per API', () => {
  for (const [k, v] of Object.entries(settings)) assert.equal(v.scope, 'resource', k);
});

test('commands that need a spec only show for one', () => {
  const palette = Object.fromEntries(pkg.contributes.menus.commandPalette.map((m) => [m.command, m.when]));
  for (const c of ['compareWithRef', 'compareWithHead', 'compareWithFile', 'releaseNotes']) assert.match(palette[`openapiBreakingChanges.${c}`], /openapiBreakingChanges\.isSpec/, c);
});

test('the package ships the third-party notices for what it bundles', () => {
  assert.match(readFileSync(new URL('../.vscodeignore', import.meta.url), 'utf8'), /^!ThirdPartyNotices\.txt$/m);
  const notices = readFileSync(new URL('../ThirdPartyNotices.txt', import.meta.url), 'utf8');
  const version = (name) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  assert.ok(notices.includes(`yaml ${version('yaml')}`), 'yaml version');
  assert.ok(notices.includes(`@vscode/codicons ${version('@vscode/codicons')}`), 'codicons version');
  assert.match(notices, /Copyright Eemeli Aro/);
  assert.match(notices, /creativecommons\.org\/licenses\/by\/4\.0/);
});
