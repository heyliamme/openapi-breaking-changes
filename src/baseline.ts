import * as vscode from 'vscode';
import { applyPolicy, atLeast, endpointLabel, looksLikeSpec, sharedMessage, type Change } from './core';
import { GitUnavailable, missingAtRef, repoFor, validRef, type Repo } from './git';
import { Superseded, type Runner } from './runner';
import { baseRef, compareOptions, liveLimit, policy, problemsLevel, SECTION, sizeOf } from './settings';
import { fromDocument, fromGit } from './sources';

const SEVERITY: Record<Change['level'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

interface Shown {
  diag: vscode.Diagnostic;
  change: Change;
  /** Every change the problem stands for: one per endpoint for a shared schema. */
  changes: Change[];
}

/**
 * The `baseRef` check: breaking changes since a Git ref, in the Problems panel, for every
 * open OpenAPI file. A change in a file the spec references is shown on that file.
 */
export class Baseline implements vscode.CodeActionProvider {
  private collection = vscode.languages.createDiagnosticCollection('openapiBreakingChanges');
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = new Map<string, number>();
  /** Per checked spec (by URI), the problems it found, by the file they are in. */
  private found = new Map<string, Map<string, Shown[]>>();
  /** Per referenced file (by URI), the specs that read it. */
  private readers = new Map<string, Set<string>>();
  /** Repositories already watched, by root: `repoFor` returns a new wrapper each time. */
  private watched = new Set<string>();
  /** Per repository root, the commits HEAD and each baseline ref were at when last checked. */
  private commits = new Map<string, string>();
  private refsInUse = new Map<string, Set<string>>();
  private disposables: vscode.Disposable[] = [this.collection];
  private warnedRef = new Set<string>();

  constructor(private runner: Runner) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.edited(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.saved(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(SECTION) && this.all()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.all()),
      vscode.languages.registerCodeActionsProvider([{ scheme: 'file', language: 'yaml' }, { scheme: 'file', language: 'json' }, { scheme: 'file', language: 'jsonc' }], this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
    this.all();
  }

  all() {
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  /** Typing: checked again once it pauses, for specs small enough; and the specs that read this file. */
  private edited(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    const live = sizeOf(doc) <= liveLimit(doc);
    if (live) this.schedule(doc, 800);
    for (const r of this.dependents(doc)) if (live || sizeOf(r) <= liveLimit(r)) this.schedule(r, 800);
  }

  private saved(doc: vscode.TextDocument) {
    this.schedule(doc, 0);
    for (const r of this.dependents(doc)) this.schedule(r, 0);
  }

  /** The open specs that reference a file. */
  private dependents(doc: vscode.TextDocument): vscode.TextDocument[] {
    const of = this.readers.get(doc.uri.toString());
    if (!of?.size) return [];
    return vscode.workspace.textDocuments.filter((d) => d !== doc && of.has(d.uri.toString()));
  }

  /** A document closed: the problems its own check found go, not those other specs found in it. */
  private forget(uri: vscode.Uri) {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.clear(key);
  }

  /** Removes what a spec's check found, everywhere it was shown. */
  private clear(key: string) {
    const was = this.found.get(key);
    this.found.delete(key);
    for (const files of this.readers.values()) files.delete(key);
    if (was) for (const file of was.keys()) this.publish(file);
  }

  /** Shows every problem found in a file, by whichever spec found it. */
  private publish(file: string) {
    const all: vscode.Diagnostic[] = [];
    for (const byFile of this.found.values()) for (const s of byFile.get(file) ?? []) all.push(s.diag);
    if (all.length) this.collection.set(vscode.Uri.parse(file), all);
    else this.collection.delete(vscode.Uri.parse(file));
  }

  private schedule(doc: vscode.TextDocument, delay: number) {
    if (doc.uri.scheme !== 'file') return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(doc);
      }, delay),
    );
  }

  private async check(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const stale = () => seq !== this.seq.get(key) || doc.isClosed;
    const ref = baseRef(doc.uri);
    if (!ref || !vscode.workspace.isTrusted || doc.isClosed || !looksLikeSpec(doc.getText())) {
      this.clear(key);
      return;
    }
    if (!validRef(ref)) {
      this.warnOnce(ref, `OpenAPI Breaking Changes: "${ref}" in ${SECTION}.baseRef is not a branch, tag or commit.`);
      this.clear(key);
      return;
    }
    let changes: Change[];
    let files: string[];
    try {
      const repo = await repoFor(doc.uri);
      this.watch(repo, ref);
      // A ref that names nothing (a typo, a branch not fetched yet) must not look like "no changes".
      if (!(await repo.resolve(ref))) {
        this.warnOnce(ref, `OpenAPI Breaking Changes: "${ref}" in ${SECTION}.baseRef is not a branch, tag or commit in ${repo.root.path.split('/').pop()}, so open specs are not checked. Fetch it or fix the setting.`);
        if (!stale()) this.clear(key);
        return;
      }
      let base;
      try {
        base = await fromGit(doc.uri, ref, repo);
      } catch (e) {
        // A spec that is new since the baseline has nothing to break.
        if (!missingAtRef(e)) this.warnOnce(ref, `OpenAPI Breaking Changes: couldn't read ${doc.uri.path.split('/').pop()} at ${ref} (${e instanceof Error ? e.message : String(e)}).`);
        if (!stale()) this.clear(key);
        return;
      }
      const current = await fromDocument(doc.uri);
      if (stale()) return;
      const r = await this.runner.run(`baseline:${key}`, { text: base.text, path: base.path, read: base.read }, { text: doc.getText(), path: current.path, read: current.read }, compareOptions(doc.uri));
      if (r.errors.old || r.errors.new) {
        if (!stale()) this.clear(key); // the YAML / JSON tools already show syntax errors
        return;
      }
      changes = applyPolicy(r.changes, policy(doc.uri));
      files = r.files.new;
    } catch (e) {
      if (e instanceof Superseded) return;
      if (!(e instanceof GitUnavailable)) console.error(e);
      if (!stale()) this.clear(key);
      return;
    }
    if (stale()) return;

    // Which files this spec reads, to check it again when one of them changes.
    for (const set of this.readers.values()) set.delete(key);
    for (const f of files) {
      if (f === doc.uri.path) continue;
      const u = doc.uri.with({ path: f }).toString();
      (this.readers.get(u) ?? this.readers.set(u, new Set()).get(u)!).add(key);
    }

    const min = problemsLevel(doc.uri);
    const byFile = new Map<string, Change[]>();
    for (const c of changes) {
      if (c.ignored !== undefined || !atLeast(c.level, min) || !c.new || !files.includes(c.new.file)) continue;
      const u = doc.uri.with({ path: c.new.file }).toString();
      (byFile.get(u) ?? byFile.set(u, []).get(u)!).push(c);
    }
    const before = [...(this.found.get(key)?.keys() ?? [])];
    const result = new Map<string, Shown[]>();
    for (const [file, mine] of byFile) result.set(file, this.diagnostics(file === key ? doc : undefined, mine, ref));
    this.found.set(key, result);
    for (const file of new Set([...before, ...result.keys()])) this.publish(file);
  }

  /** Problems for the changes found in one file. */
  private diagnostics(doc: vscode.TextDocument | undefined, mine: Change[], ref: string): Shown[] {
    // A change in a shared schema shows up once per endpoint that uses it: one problem, listing
    // them, named by the schema when the endpoints word it differently.
    const same = new Map<string, Change[]>();
    for (const c of mine) {
      const k = `${c.id}|${c.level}|${c.new!.line}|${c.new!.col}|${c.old?.file}#${c.old?.pointer}`;
      (same.get(k) ?? same.set(k, []).get(k)!).push(c);
    }
    const groups: Array<{ change: Change; changes: Change[]; message: string; endpoints: string[] }> = [];
    for (const cs of same.values()) {
      const shared = cs.length > 1 ? sharedMessage(cs) : undefined;
      if (shared) groups.push({ change: cs[0], changes: cs, message: shared, endpoints: [...new Set(cs.map(endpointLabel))] });
      else {
        const byMessage = new Map<string, Change[]>();
        for (const c of cs) (byMessage.get(c.message) ?? byMessage.set(c.message, []).get(c.message)!).push(c);
        for (const [message, of] of byMessage) groups.push({ change: of[0], changes: of, message, endpoints: of.map(endpointLabel) });
      }
    }
    const textDoc = doc ?? vscode.workspace.textDocuments.find((d) => d.uri.path === mine[0]?.new?.file && d.uri.scheme === 'file');
    const shown: Shown[] = [];
    for (const { change: c, changes, message, endpoints } of groups) {
      let range: vscode.Range;
      if (textDoc) {
        const line = Math.min(c.new!.line, textDoc.lineCount - 1);
        const text = textDoc.lineAt(line).text;
        const start = Math.min(c.new!.col, text.length);
        range = new vscode.Range(line, start, line, Math.max(start, text.trimEnd().length));
      } else range = new vscode.Range(c.new!.line, c.new!.col, c.new!.line, c.new!.col);
      const where = endpoints.length > 3 ? `${endpoints.slice(0, 2).join(', ')} and ${endpoints.length - 2} more endpoints` : endpoints.join(', ');
      const d = new vscode.Diagnostic(range, `${strip(message)} (${where})`, SEVERITY[c.level]);
      d.source = `since ${ref}`;
      d.code = c.id;
      shown.push({ diag: d, change: c, changes });
    }
    return shown;
  }

  /**
   * Checking out, committing or fetching can move what HEAD or the baseline ref point at;
   * then every open spec is checked again. Git also reports a status after every save,
   * which moves nothing: those are skipped.
   */
  private watch(repo: Repo, ref: string) {
    const root = repo.root.toString();
    (this.refsInUse.get(root) ?? this.refsInUse.set(root, new Set()).get(root)!).add(ref);
    if (this.watched.has(root) || !repo.onDidChange) return;
    this.watched.add(root);
    const where = async () => {
      const refs = ['HEAD', ...(this.refsInUse.get(root) ?? [])];
      return (await Promise.all(refs.map(async (r) => `${r}=${(await repo.resolve(r)) ?? ''}`))).join(' ');
    };
    void where().then((w) => this.commits.set(root, w));
    let t: ReturnType<typeof setTimeout> | undefined;
    this.disposables.push(
      repo.onDidChange(() => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const now = await where();
          if (now === this.commits.get(root)) return;
          this.commits.set(root, now);
          this.all();
        }, 1500);
      }),
    );
  }

  private warnOnce(ref: string, msg: string) {
    if (this.warnedRef.has(ref)) return;
    this.warnedRef.add(ref);
    void vscode.window.showWarningMessage(msg);
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const file = doc.uri.toString();
    const shown: Array<{ spec: string; s: Shown }> = [];
    for (const [spec, byFile] of this.found) for (const s of byFile.get(file) ?? []) shown.push({ spec, s });
    if (!shown.length) return [];
    const actions: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      const hit = shown.find((x) => x.s.diag.code === d.code && x.s.diag.message === d.message && x.s.diag.range.isEqual(d.range));
      if (!hit) continue;
      const c = hit.s.change;
      const spec = vscode.Uri.parse(hit.spec);
      const ignore = new vscode.CodeAction(`Ignore ${c.id}…`, vscode.CodeActionKind.QuickFix);
      ignore.diagnostics = [d];
      ignore.command = { command: 'openapiBreakingChanges.ignoreChange', title: 'Ignore', arguments: [hit.s.changes, spec] };
      const report = new vscode.CodeAction('Show all API changes since the baseline', vscode.CodeActionKind.QuickFix);
      report.diagnostics = [d];
      report.command = { command: 'openapiBreakingChanges.showBaselineReport', title: 'Show', arguments: [spec] };
      actions.push(report, ignore);
    }
    return actions;
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** Backticks read fine in the report, less so in the Problems panel. */
const strip = (s: string) => s.replace(/`/g, "'");
