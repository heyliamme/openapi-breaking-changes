import * as vscode from 'vscode';
import { Baseline } from './baseline';
import * as fs from 'fs';
import { applyPolicy, compareVersions, guessOrder, looksLikeSpec, toReleaseNotes, versionParts, type Change } from './core';
import { GitUnavailable, missingAtRef, registerShowProvider, repoFor, validRef, type RefItem } from './git';
import { openReleaseNotes, promptIgnore, ReportPanel, VIEW_TYPE } from './panel';
import { Runner } from './runner';
import { baseRef, compareOptions, policy } from './settings';
import { distinguish, fromDiffSide, fromDocument, fromGit, MAX_FILE_BYTES, shortRef, type SpecSource } from './sources';

const SPEC_FILE = /\.(ya?ml|json)$/i;
const RECENT_REFS = 'recentRefs';
const WORKING_COPY = '\0working-copy';

/** A spec that isn't there at a ref: new since then. */
class NewSince extends Error {}

export function activate(context: vscode.ExtensionContext) {
  const runner = Runner.forExtension(context.extensionPath);
  ReportPanel.runner = runner;
  context.subscriptions.push(runner);
  const show = (o: SpecSource, n: SpecSource) => ReportPanel.show(context.extensionUri, o, n);
  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof GitUnavailable || e instanceof NewSince) vscode.window.showInformationMessage(msg);
        else vscode.window.showErrorMessage(`OpenAPI Breaking Changes: ${msg}`);
      }
    });

  /** The spec a command acts on: the file it was invoked on, else the active editor's. */
  const target = (uri?: unknown): vscode.Uri | undefined => {
    if (uri instanceof vscode.Uri) return uri;
    const doc = vscode.window.activeTextEditor?.document;
    if (doc) return doc.uri;
    vscode.window.showInformationMessage('Open an OpenAPI or Swagger file first.');
    return undefined;
  };

  const requireSpec = (s: SpecSource) => {
    if (!looksLikeSpec(s.text)) throw new Error(`${s.label} doesn't look like an OpenAPI or Swagger spec (no top-level \`openapi\` or \`swagger\` field).`);
  };

  const remember = async (ref: string) => {
    const recent = context.workspaceState.get<string[]>(RECENT_REFS, []);
    await context.workspaceState.update(RECENT_REFS, [ref, ...recent.filter((r) => r !== ref)].slice(0, 5));
  };

  const atRef = async (file: vscode.Uri, ref: string) => {
    const name = file.path.split('/').pop();
    try {
      return await fromGit(file, ref);
    } catch (e) {
      if (e instanceof GitUnavailable) throw e;
      if (missingAtRef(e)) throw new NewSince(`${name} is new since ${shortRef(ref)}: it isn't in that version, so everything in it is an addition.`);
      throw new Error(`couldn't read ${name} at ${shortRef(ref)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const compareWithRef = async (file: vscode.Uri, ref: string, current?: SpecSource) => {
    current ??= await fromDocument(file);
    requireSpec(current);
    current.name = 'the working copy';
    const base = await atRef(file, ref);
    await remember(ref);
    show(base, current);
  };

  context.subscriptions.push(
    registerShowProvider(),
    new Baseline(runner),

    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        await ReportPanel.revive(context.extensionUri, panel, state);
      },
    }),

    command('openapiBreakingChanges.compareWithHead', async (uri?: vscode.Uri) => {
      const file = target(uri);
      if (file) await compareWithRef(file, 'HEAD');
    }),

    command('openapiBreakingChanges.compareWithRef', async (uri?: vscode.Uri) => {
      // From a diff editor, the shortcut means "check this diff".
      if (!(uri instanceof vscode.Uri) && vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff)
        return vscode.commands.executeCommand('openapiBreakingChanges.fromDiffEditor');
      const file = target(uri);
      if (!file) return;
      // Is it a spec at all? Before asking for a ref.
      const current = await fromDocument(file);
      requireSpec(current);
      const repo = await repoFor(file);
      const ref = await pickRef(repo.refs(), context.workspaceState.get<string[]>(RECENT_REFS, []));
      if (ref) await compareWithRef(file, ref, ref === 'HEAD' ? undefined : current);
    }),

    command('openapiBreakingChanges.releaseNotes', async (uri?: vscode.Uri) => {
      const file = target(uri);
      if (!file) return;
      const current = await fromDocument(file);
      requireSpec(current);
      const repo = await repoFor(file);
      const refs = repo.refs();
      const last = await repo.lastTag();
      const from = await pickRef(refs, context.workspaceState.get<string[]>(RECENT_REFS, []), {
        title: 'Release notes since which version?',
        placeholder: 'The previous release: a tag, branch or commit',
        top: last ? [{ label: `$(tag) ${last}`, description: 'latest tag', ref: last }] : [],
      });
      if (!from) return;
      const to = await pickRef(refs, [], {
        title: `Release notes from ${shortRef(from)} to which version?`,
        placeholder: 'The new release: the working copy, a tag, branch or commit',
        top: [{ label: '$(file) Working copy', description: 'the spec as it is in the editor', ref: WORKING_COPY }],
        exclude: from,
      });
      if (!to) return;
      await remember(from);
      const o = await atRef(file, from);
      const n = to === WORKING_COPY ? { ...current, name: 'the working copy' } : await atRef(file, to);
      await writeReleaseNotes(runner, file, o, n);
    }),

    command('openapiBreakingChanges.compareWithFile', async (uri?: vscode.Uri) => {
      const file = target(uri);
      if (!file) return;
      const current = await fromDocument(file);
      requireSpec(current);
      const other = await pickSpecFile(file);
      if (other) show(await fromDocument(other), current);
    }),

    command('openapiBreakingChanges.compareSelected', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const files = uris?.length ? uris : uri ? [uri] : [];
      if (files.length !== 2) {
        vscode.window.showInformationMessage('Select exactly two spec files in the Explorer.');
        return;
      }
      const [a, b] = await Promise.all(files.map((f) => fromDocument(f)));
      requireSpec(a);
      requireSpec(b);
      distinguish(a, b);
      // Which is older: info.version, then the names; ask when neither says.
      const guess = guessOrder({ name: a.label, text: a.text }, { name: b.label, text: b.text });
      let old: 0 | 1;
      if (guess) old = guess.old;
      else {
        const pick = await vscode.window.showQuickPick(
          [a, b].map((s, i) => ({ label: s.label, description: s.detail, i: i as 0 | 1 })),
          { title: 'Which is the old version?', placeHolder: "The names and info.version don't say: pick the spec to compare from" },
        );
        if (!pick) return;
        old = pick.i;
      }
      show(old === 0 ? a : b, old === 0 ? b : a);
    }),

    command('openapiBreakingChanges.fromDiffEditor', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      if (!(input instanceof vscode.TabInputTextDiff)) {
        vscode.window.showInformationMessage('Open a diff editor first, for example a changed spec in Source Control.');
        return;
      }
      const [o, n] = await Promise.all([fromDiffSide(input.original), fromDiffSide(input.modified)]);
      // An added file: its diff has nothing on the left.
      if (!o.text.trim() && looksLikeSpec(n.text)) {
        vscode.window.showInformationMessage(`${n.label} is a new file in this diff: there is no old version, so everything in it is an addition.`);
        return;
      }
      if (o.label === n.label) {
        // Other diffs (Compare with Saved, extensions' own schemes): take the names VS Code shows.
        const shown = tab!.label.split(' ↔ ');
        if (shown.length === 2 && shown[0] !== shown[1]) [o.label, n.label] = shown;
        else o.label += ' (original)';
      }
      requireSpec(n);
      show(o, n);
    }),

    command('openapiBreakingChanges.showBaselineReport', async (uri?: vscode.Uri) => {
      const file = target(uri);
      if (!file) return;
      const ref = baseRef(file);
      if (!ref) {
        const pick = await vscode.window.showInformationMessage('Set openapiBreakingChanges.baseRef to the branch or tag to check against.', 'Open Settings');
        if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', 'openapiBreakingChanges.baseRef');
        return;
      }
      if (!validRef(ref)) throw new Error(`"${ref}" is not a branch, tag or commit.`);
      await compareWithRef(file, ref);
    }),

    command('openapiBreakingChanges.ignoreChange', (c: Change | Change[], uri?: vscode.Uri) => promptIgnore(c, uri)),
  );

  // Menus, the shortcut and the diff editor button show for OpenAPI files, recognised by
  // content. Cached per document version: selection changes are frequent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: { key: string; isSpec: boolean } | undefined;
  const updateContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const key = doc ? `${doc.uri.toString()}@${doc.version}` : '';
    if (last?.key === key) return;
    const isSpec = !!doc && (SPEC_FILE.test(doc.uri.path) || ['yaml', 'json', 'jsonc'].includes(doc.languageId)) && looksLikeSpec(doc.getText());
    if (last?.isSpec !== isSpec) void vscode.commands.executeCommand('setContext', 'openapiBreakingChanges.isSpec', isSpec);
    last = { key, isSpec };
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.onDidChangeVisibleTextEditors(updateContext),
    vscode.window.onDidChangeTextEditorSelection((e) => e.textEditor === vscode.window.activeTextEditor && updateContext()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== vscode.window.activeTextEditor?.document) return;
      clearTimeout(timer);
      timer = setTimeout(updateContext, 500);
    }),
    { dispose: () => clearTimeout(timer) },
  );
  updateContext();
  // Activation often comes from opening the very spec that isn't the active editor yet.
  setTimeout(updateContext, 300);
}

async function writeReleaseNotes(runner: Runner, file: vscode.Uri, o: SpecSource, n: SpecSource) {
  const r = await runner.run(`release-notes:${file.toString()}`, { text: o.text, path: o.path, read: o.read }, { text: n.text, path: n.path, read: n.read }, compareOptions(file));
  const err = r.errors.old ?? r.errors.new;
  if (err) throw new Error(`couldn't read ${err === r.errors.old ? o.label : n.label}: ${err.message}`);
  const md = toReleaseNotes(applyPolicy(r.changes, policy(file)), { from: o.name, to: n.name, versions: r.apiVersions, spec: file.path.split('/').pop() });
  await openReleaseNotes(md);
}

interface RefPick extends vscode.QuickPickItem {
  ref?: string;
  enter?: boolean;
}

async function pickRef(refs: Promise<RefItem[]>, recent: string[], opts: { title?: string; placeholder?: string; top?: RefPick[]; exclude?: string } = {}): Promise<string | undefined> {
  type Item = RefPick;
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = opts.title ?? 'Compare with which version?';
  qp.placeholder = opts.placeholder ?? 'A branch, tag or commit: the old side of the comparison';
  qp.matchOnDescription = true;
  qp.busy = true;
  const enter: Item = { label: '$(edit) Enter a commit or ref…', enter: true, alwaysShow: true };
  const top = opts.top ?? [];
  qp.items = [...top, { label: 'HEAD', description: 'last commit', ref: 'HEAD' }, enter];
  qp.show();
  const icon: Record<RefItem['kind'], string> = { head: '$(git-commit)', branch: '$(git-branch)', remote: '$(cloud)', tag: '$(tag)' };
  refs.then(
    (list) => {
      const items: Item[] = [...top];
      const skip = new Set([...top.map((t) => t.ref), opts.exclude]);
      list = list.filter((r) => !skip.has(r.name));
      // Newest versions first.
      const tags = list.filter((r) => r.kind === 'tag').sort((x, y) => compareVersions(versionParts(y.name) ?? [], versionParts(x.name) ?? []) || y.name.localeCompare(x.name));
      list = [...list.filter((r) => r.kind !== 'tag'), ...tags];
      const byName = new Map(list.map((r) => [r.name, r]));
      const recentItems = recent.filter((r) => r !== 'HEAD' && !skip.has(r));
      if (recentItems.length) {
        items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
        for (const r of recentItems) items.push({ label: `${icon[byName.get(r)?.kind ?? 'head']} ${r}`, description: byName.get(r)?.commit?.slice(0, 8), ref: r });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      if (!skip.has('HEAD')) items.push({ label: `${icon.head} HEAD`, description: 'last commit', ref: 'HEAD' });
      const section = (title: string, kind: RefItem['kind']) => {
        const of = list.filter((r) => r.kind === kind && !recentItems.includes(r.name));
        if (!of.length) return;
        items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
        for (const r of of) items.push({ label: `${icon[kind]} ${r.name}`, description: r.commit?.slice(0, 8), ref: r.name });
      };
      section('Branches', 'branch');
      section('Tags', 'tag');
      section('Remote branches', 'remote');
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, enter);
      qp.items = items;
      qp.busy = false;
    },
    () => (qp.busy = false),
  );
  const picked = await new Promise<Item | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  const typed = qp.value.trim();
  qp.dispose();
  if (!picked) return undefined;
  if (picked.enter) {
    const ref = await vscode.window.showInputBox({
      title: 'Compare with which commit or ref?',
      prompt: 'A commit hash, branch, tag, or an expression such as HEAD~3 or main@{yesterday}',
      value: typed,
      validateInput: (v) => (validRef(v.trim()) ? undefined : 'Not a valid ref'),
    });
    return ref?.trim() || undefined;
  }
  return picked.ref;
}

async function pickSpecFile(exclude: vscode.Uri): Promise<vscode.Uri | undefined> {
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Compare with which spec?';
  qp.placeholder = 'The old version: an OpenAPI or Swagger file';
  qp.matchOnDescription = true;
  qp.busy = true;
  const browse: Item = { label: '$(folder-opened) Browse…', browse: true, alwaysShow: true };
  const items: Item[] = [];
  const seen = new Set<string>([exclude.toString()]);
  const name = (u: vscode.Uri) => u.path.split('/').pop()!;
  const add = (u: vscode.Uri, group: string) => {
    if (seen.has(u.toString())) return;
    seen.add(u.toString());
    if (!items.some((i) => i.kind === vscode.QuickPickItemKind.Separator && i.label === group)) items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
    const rel = vscode.workspace.asRelativePath(u);
    items.push({ label: `$(file-code) ${name(u)}`, description: rel === name(u) ? undefined : rel, uri: u });
    qp.items = [...items, { label: '', kind: vscode.QuickPickItemKind.Separator }, browse];
  };
  qp.items = [browse];
  qp.show();
  for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === 'file' && SPEC_FILE.test(d.uri.path) && looksLikeSpec(d.getText())) add(d.uri, 'Open files');
  // The scan stops once the picker closes.
  const cancel = new vscode.CancellationTokenSource();
  const scan = (async () => {
    if (!vscode.workspace.workspaceFolders?.length) return;
    // Passing an exclude replaces files.exclude: keep its patterns.
    const hidden = Object.entries(vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude') ?? {})
      .filter(([g, on]) => on === true && !/[{}]/.test(g))
      .map(([g]) => g);
    const exclude = `{${['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/vendor/**', ...hidden].join(',')}}`;
    const found = await vscode.workspace.findFiles('**/*.{yaml,yml,json}', exclude, 3000, cancel.token);
    found.sort((a, b) => a.path.localeCompare(b.path));
    for (let i = 0; i < found.length && !cancel.token.isCancellationRequested; i += 32) {
      const batch = found.slice(i, i + 32);
      const specs = await Promise.all(batch.map(isSpecFile));
      batch.forEach((u, j) => specs[j] && add(u, 'Workspace'));
    }
  })();
  scan.catch(() => undefined).finally(() => (qp.busy = false));
  const picked = await new Promise<Item | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  cancel.cancel();
  cancel.dispose();
  qp.dispose();
  if (!picked) return undefined;
  if (picked.browse) {
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'OpenAPI specs': ['yaml', 'yml', 'json'], 'All files': ['*'] } });
    return r?.[0];
  }
  return picked.uri;
}

/**
 * Whether a file is a spec. The start of it usually says; a spec with sorted keys has
 * `openapi` after `components`, so when the start doesn't, the whole file is read.
 */
async function isSpecFile(u: vscode.Uri): Promise<boolean> {
  const first = 64 * 1024;
  try {
    if (u.scheme === 'file') {
      // Not opened unless it is a regular file: opening a FIFO waits for a writer.
      const st = await fs.promises.stat(u.fsPath);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
      const fh = await fs.promises.open(u.fsPath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(first, st.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        if (looksLikeSpec(new TextDecoder().decode(buf.subarray(0, bytesRead)))) return true;
        if (st.size <= first) return false;
      } finally {
        await fh.close();
      }
      return looksLikeSpec(new TextDecoder().decode(await fs.promises.readFile(u.fsPath)));
    }
    const st = await vscode.workspace.fs.stat(u);
    if (!(st.type & vscode.FileType.File) || st.size > MAX_FILE_BYTES) return false;
    return looksLikeSpec(new TextDecoder().decode(await vscode.workspace.fs.readFile(u)));
  } catch {
    return false;
  }
}

export function deactivate() {}
