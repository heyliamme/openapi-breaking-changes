# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the smallest old and new spec that show the problem, what you
expected and what you saw. For a change that was judged at the wrong level, say how a
client would (or wouldn't) break. The output of **Copy as Markdown** helps.

## Running from source

Node 22 or newer.

```bash
git clone https://github.com/heyliamme/openapi-breaking-changes
cd openapi-breaking-changes
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host with the extension
loaded and the `samples` folder open.

## Tests

```bash
npm test
```

- `test/rules.test.mjs` covers every rule, from both directions where it applies, moved
  endpoints, callbacks and webhooks, and fails if a rule in the catalog is never produced
  or a change comes out at another level than the catalog's.
- `test/spec.test.mjs` covers parsing and positions, `$ref`s within and across files and
  by `$id` / `$anchor`, recursive schemas, malformed input and large specs.
- `test/swagger.test.mjs` covers Swagger 2.0 and specs moving from 2.0 to 3.x.
- `test/report.test.mjs` covers ignore rules, the Markdown changelog, release notes, the
  report's grouping, telling the old file from the new, and checks the README's tables
  are exactly what `scripts/rules-table.mjs` prints.
- `test/manifest.test.mjs` checks the extension manifest and the third-party notices.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile and
uses it as a person would: shortcuts, menus (the Explorer's too), quick picks, Git, the
diff editor, the report's buttons, release notes and the Problems panel, then opens the
workspace again untrusted to check Restricted Mode. VS Code runs headless, so it doesn't take over
your screen. Linux only (it uses Chromium's headless mode), with `code` on your `PATH`
(or set `VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
E2E_SHOTS=images npm run test:e2e   # also retakes the README screenshots
```

Screenshots of failing steps land in the temporary folder it prints.

## Working on the report in a browser

```bash
npm run build
node harness/preview.mjs samples/petstore-v1.yaml samples/petstore-v2.yaml
google-chrome "file://$PWD/out/preview.html?theme=light"
```

## Adding a rule

1. Add it to `src/core/rules.ts` (an id, its level, a one-line summary).
2. Detect it in `src/core/diff.ts` (endpoints, parameters, bodies, responses, links,
   callbacks, webhooks, security) or `src/core/schema.ts` (anything inside a schema). An
   operation rule needs its level inside callbacks and webhooks too (`reversed`).
3. Add a test to `test/rules.test.mjs`, from both directions if it applies to schemas.
4. Regenerate the README tables: `npm run build && node scripts/rules-table.mjs`.

## Layout

| Path | |
| --- | --- |
| `src/core/parse.ts`, `json.ts` | YAML and JSON parsing that keeps line positions |
| `src/core/spec.ts` | Loading a spec and the files it references, `$ref` resolution |
| `src/core/diff.ts` | Endpoints, parameters, bodies, responses, security |
| `src/core/schema.ts` | Schema comparison |
| `src/core/rules.ts` | The catalog of change ids and levels |
| `src/core/policy.ts`, `markdown.ts` | Ignore rules, the Markdown changelog, release notes |
| `src/core/order.ts` | Which of two files is the old one |
| `src/git.ts`, `src/sources.ts` | Reading specs from files, Git and diff editors |
| `src/panel.ts`, `webview/` | The report |
| `src/baseline.ts` | The Problems panel check |
| `src/extension.ts` | Commands |

`src/core` has no VS Code dependency and is what the unit tests load.

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include screenshots in light and dark themes.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
