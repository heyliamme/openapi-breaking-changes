import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { applyPolicy, count, endpointLabel, mdText, toMarkdown, toReleaseNotes, type Change, type IgnoreRule, type Result } from './core';
import type { FromWebview, Report, SideName, ToWebview, ViewState } from './protocol';
import { Superseded, type Runner } from './runner';
import { escapePath } from './core';
import { addIgnore, compareOptions, liveLimit, policy, SECTION, sizeOf } from './settings';
import { distinguish, fromRestore, type Restore, type SpecSource } from './sources';

export const VIEW_TYPE = 'openapiBreakingChanges';

interface Saved {
  old?: Restore;
  new?: Restore;
  view?: ViewState;
}

export class ReportPanel {
  private static open = new Set<ReportPanel>();
  private static ids = 0;
  /** Runs the comparisons; set when the extension starts. */
  static runner: Runner;
  private id = ++ReportPanel.ids;
  private panel: vscode.WebviewPanel;
  private disposed = false;
  /** The settings that apply: those of the file the comparison started from, whichever side it is on. */
  private scope?: vscode.Uri;
  /** Every file each side was read from, to compare again when one of them is edited. */
  private files = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private result?: Result;
  private changes: Change[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private seq = 0;
  private ready = false;
  private view?: ViewState;

  /** Opens a report, or brings back the one already showing these two sides. */
  static show(extensionUri: vscode.Uri, oldSide: SpecSource, newSide: SpecSource) {
    distinguish(oldSide, newSide);
    const key = JSON.stringify([oldSide.restore, newSide.restore]);
    for (const p of ReportPanel.open) {
      if (JSON.stringify([p.sides.old.restore, p.sides.new.restore]) === key) {
        p.sides = { old: oldSide, new: newSide };
        p.panel.reveal();
        void p.update();
        return p;
      }
    }
    return new ReportPanel(extensionUri, { old: oldSide, new: newSide });
  }

  static async revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, state: unknown) {
    // The webview keeps { persist: { old, new }, view } (see webview/main.ts).
    const kept = (state ?? {}) as { persist?: Saved; view?: ViewState };
    const saved: Saved = { ...(kept.persist ?? {}), view: kept.view };
    try {
      if (!saved.old || !saved.new) throw new Error('nothing to restore');
      const [o, n] = await Promise.all([fromRestore(saved.old), fromRestore(saved.new)]);
      const p = new ReportPanel(extensionUri, { old: o, new: n }, panel);
      p.view = saved.view;
      return p;
    } catch {
      panel.dispose();
      return undefined;
    }
  }

  /** The panels showing a document, to refresh after settings change. */
  static all() {
    return [...ReportPanel.open];
  }

  private constructor(
    private extensionUri: vscode.Uri,
    private sides: Record<SideName, SpecSource>,
    existing?: vscode.WebviewPanel,
  ) {
    distinguish(sides.old, sides.new);
    this.scope = sides.new.scope ?? sides.old.scope;
    const options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
    this.panel = existing ?? vscode.window.createWebviewPanel(VIEW_TYPE, this.title(), vscode.ViewColumn.Active, options);
    if (existing) existing.webview.options = options;
    this.panel.title = this.title();
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: FromWebview) =>
        this.onMessage(m).catch((e) => {
          if (!this.disposed) vscode.window.showErrorMessage(`OpenAPI Breaking Changes: ${e instanceof Error ? e.message : String(e)}`);
        }),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document, false), null, this.disposables);
    vscode.workspace.onDidSaveTextDocument((d) => this.onDocument(d, true), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration(`${SECTION}.detectMovedEndpoints`)) void this.update();
        else if (e.affectsConfiguration(SECTION)) this.applyPolicy();
      },
      null,
      this.disposables,
    );
    // Trusting the folder brings in its ignore rules.
    vscode.workspace.onDidGrantWorkspaceTrust(() => this.applyPolicy(), null, this.disposables);
    ReportPanel.open.add(this);
    void this.update();
  }

  private title() {
    const { old: o, new: n } = this.sides;
    return `API changes: ${o.label} → ${n.label}`;
  }

  private post(m: ToWebview) {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(m);
  }

  /**
   * An edit to a side's document, or to a file a side's spec references: compare again once
   * typing pauses (large specs: when saved). The texts are read when the timer fires, so
   * edits to both sides, or a swap in between, are all taken in.
   */
  private onDocument(doc: vscode.TextDocument, saved: boolean) {
    const uri = doc.uri.toString();
    const main = (['old', 'new'] as const).some((s) => this.sides[s].live?.toString() === uri);
    const referenced = !main && doc.uri.scheme === 'file' && this.files.has(doc.uri.path) && (['old', 'new'] as const).some((s) => this.sides[s].live);
    if (!main && !referenced) return;
    if (!saved && sizeOf(doc) > liveLimit(doc)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const s of ['old', 'new'] as const) {
        const live = this.sides[s].live?.toString();
        const d = live && vscode.workspace.textDocuments.find((x) => x.uri.toString() === live);
        if (d) this.sides[s] = { ...this.sides[s], text: d.getText() };
      }
      void this.update();
    }, saved ? 0 : 400);
  }

  /** Re-runs the comparison. Later runs win over slower earlier ones. */
  async update() {
    if (this.disposed) return;
    const seq = ++this.seq;
    const { old: o, new: n } = this.sides;
    this.panel.title = this.title();
    let result: Result;
    try {
      result = await ReportPanel.runner.run(`panel:${this.id}`, { text: o.text, path: o.path, read: o.read }, { text: n.text, path: n.path, read: n.read }, compareOptions(this.scope));
    } catch (e) {
      if (e instanceof Superseded) return;
      result = { changes: [], errors: { new: { message: `The comparison failed: ${e instanceof Error ? e.message : String(e)}`, file: n.path } }, warnings: [], notes: [], files: { old: [], new: [] }, versions: {}, apiVersions: {}, ms: 0 };
    }
    if (seq !== this.seq || this.disposed) return;
    this.result = result;
    this.files = new Set([...result.files.old, ...result.files.new]);
    this.applyPolicy();
  }

  private applyPolicy() {
    const r = this.result;
    if (!r || this.disposed) return;
    const p = policy(this.scope);
    this.changes = applyPolicy(r.changes, p);
    const report: Report = {
      old: { label: this.sides.old.label, detail: this.sides.old.detail, path: this.sides.old.path, version: r.versions.old, error: r.errors.old },
      new: { label: this.sides.new.label, detail: this.sides.new.detail, path: this.sides.new.path, version: r.versions.new, error: r.errors.new },
      changes: this.changes,
      counts: count(this.changes),
      warnings: r.warnings,
      notes: r.notes,
      ms: r.ms,
      strict: p.warningsAsErrors,
    };
    this.post({ type: 'report', report });
    this.saveState();
  }

  private saveState() {
    this.post({ type: 'persist', state: { old: this.sides.old.restore, new: this.sides.new.restore } satisfies Saved });
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.view) this.post({ type: 'view', view: this.view });
        this.post({ type: 'loading' });
        if (this.result) this.applyPolicy();
        break;
      case 'open': {
        const uri = this.sides[m.side].uriFor(m.file);
        if (!uri) {
          vscode.window.showInformationMessage("This side can't be opened in an editor.");
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const pos = new vscode.Position(m.line, m.col);
          const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
          await vscode.window.showTextDocument(doc, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos), preview: true });
        } catch (e) {
          vscode.window.showErrorMessage(`OpenAPI Breaking Changes: couldn't open ${m.file} (${e instanceof Error ? e.message : String(e)}).`);
        }
        break;
      }
      case 'copyMarkdown': {
        if (!this.compared()) return;
        const md = toMarkdown(this.changes, `API changes: ${mdText(this.sides.old.label)} → ${mdText(this.sides.new.label)}`);
        await vscode.env.clipboard.writeText(md);
        vscode.window.setStatusBarMessage('$(check) Copied the changes as Markdown', 3000);
        break;
      }
      case 'releaseNotes': {
        if (!this.compared()) return;
        const r = this.result!;
        await openReleaseNotes(toReleaseNotes(this.changes, { from: this.sides.old.name, to: this.sides.new.name, versions: r.apiVersions, spec: this.sides.new.label.replace(/ \(.*\)$/, '') }));
        break;
      }
      case 'ignore': {
        const c = this.changes[m.index];
        if (c) await promptIgnore(c, this.scope);
        break;
      }
      case 'swap':
        this.sides = { old: this.sides.new, new: this.sides.old };
        this.post({ type: 'loading' });
        void this.update();
        break;
      case 'refresh':
        this.post({ type: 'loading' });
        try {
          const [o, n] = await Promise.all([this.sides.old.reload(), this.sides.new.reload()]);
          if (this.disposed) return;
          distinguish(o, n);
          this.sides = { old: o, new: n };
        } catch (e) {
          if (this.disposed) return;
          vscode.window.showErrorMessage(`OpenAPI Breaking Changes: ${e instanceof Error ? e.message : String(e)}`);
        }
        void this.update();
        break;
    }
  }

  /** Both sides were read and compared: there is something to copy. */
  private compared(): boolean {
    const r = this.result;
    if (r && !r.errors.old && !r.errors.new) return true;
    vscode.window.showInformationMessage(r ? 'Nothing was compared: one side could not be read.' : 'The comparison is still running.');
    return false;
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    ReportPanel.open.delete(this);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}

/**
 * Asks how widely to ignore a change, then saves the rule to settings. A change to a shared
 * schema stands for one change per endpoint: "This change" covers each of them.
 */
export async function promptIgnore(of: Change | Change[], scope?: vscode.Uri) {
  type Item = vscode.QuickPickItem & { rule: IgnoreRule | string | Array<IgnoreRule | string> };
  const cs = Array.isArray(of) ? of : [of];
  const c = cs[0];
  if (!c) return;
  const items: Item[] = [];
  // The path as written in the spec, not a pattern: a `*` in it matches only itself.
  const placed = cs.filter((x) => x.path && x.method);
  const eps = [...new Set(placed.map((x) => endpointLabel(x)))];
  const at = (x: Change) => ({ method: x.method!.toLowerCase(), path: escapePath(x.path!) });
  const on = eps.length === 1 ? eps[0] : `${eps.length} endpoints`;
  if (placed.length) items.push({ label: 'This change', description: `${c.id} on ${on}`, rule: placed.map((x) => ({ id: x.id, ...at(x) })) });
  items.push({ label: `Every ${c.id}`, description: 'on every endpoint', rule: c.id });
  if (placed.length) items.push({ label: `Everything on ${on}`, description: eps.length === 1 ? 'any change to this endpoint' : 'any change to these endpoints', rule: placed.map(at) });
  const pick = await vscode.window.showQuickPick(items, { title: 'Ignore which changes?', placeHolder: 'Ignored changes stay in the report, dimmed, and leave the counts and the Problems panel' });
  if (!pick) return;
  // In Restricted Mode the workspace's ignore rules are not applied: saying "added" there
  // would be a rule that does nothing.
  let user = false;
  if (!vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length) {
    const choice = await vscode.window.showInformationMessage(
      "This folder is in Restricted Mode, so ignore rules in its settings aren't applied until you trust it. Add the rule to your user settings instead?",
      'Add to User Settings',
      'Manage Workspace Trust',
    );
    if (choice === 'Manage Workspace Trust') await vscode.commands.executeCommand('workbench.trust.manage');
    if (choice !== 'Add to User Settings') return;
    user = true;
  }
  let where: string;
  try {
    where = await addIgnore(pick.rule, scope, user);
  } catch (e) {
    vscode.window.showErrorMessage(`OpenAPI Breaking Changes: the ignore rule was not added (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }
  vscode.window.setStatusBarMessage(`$(check) Added to ${where} settings: ${SECTION}.ignore`, 4000);
}


/** Opens release notes in a new Markdown editor, to edit and copy. */
export async function openReleaseNotes(md: string) {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, { preview: false });
}
