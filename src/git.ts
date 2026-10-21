import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** The parts of the built-in Git extension's API this extension uses. */
interface GitRef {
  type: number; // 0 head, 1 remote head, 2 tag
  name?: string;
  commit?: string;
  remote?: string;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: GitRef; refs?: GitRef[]; onDidChange: vscode.Event<void> };
  show(ref: string, path: string): Promise<string>;
  getRefs?(query?: unknown): Promise<GitRef[]>;
}
interface GitApi {
  state: string;
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri;
  onDidOpenRepository: vscode.Event<GitRepository>;
}

export interface RefItem {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
  commit?: string;
}

/** A Git repository, through the built-in Git extension or, without it, the git CLI. */
export interface Repo {
  root: vscode.Uri;
  show(ref: string, file: vscode.Uri): Promise<string>;
  refs(): Promise<RefItem[]>;
  /** A URI that opens the file as of `ref` in a read-only editor. */
  uriAt(file: vscode.Uri, ref: string): vscode.Uri;
  /** The most recent tag reachable from HEAD (`git describe`), if any. */
  lastTag(): Promise<string | undefined>;
  /** The commit a ref names, or undefined when it names none in this repository. */
  resolve(ref: string): Promise<string | undefined>;
  onDidChange?: vscode.Event<void>;
}

export class GitUnavailable extends Error {}

let apiPromise: Promise<GitApi | undefined> | undefined;

async function gitApi(): Promise<GitApi | undefined> {
  apiPromise ??= (async () => {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi; enabled?: boolean }>('vscode.git');
    if (!ext) return undefined;
    try {
      const exp = ext.isActive ? ext.exports : await ext.activate();
      if (exp.enabled === false) return undefined;
      return exp.getAPI(1);
    } catch {
      return undefined;
    }
  })();
  return apiPromise;
}

/** Refs come from settings and quick picks: never let one turn into a git option. */
export function validRef(ref: string): boolean {
  return /^[^\s-][^\s:]*$/.test(ref) && !ref.includes('..') && ref.length < 256;
}

function run(args: string[], cwd: string, maxBuffer = 256 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

/** Where a path really is, through symbolic links; for a file that isn't there, its folder's. */
function realPath(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

const within = (root: string, file: string) => {
  // Drive letters and, on macOS and Windows, names are not case-sensitive.
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const r = (fold ? root.toLowerCase() : root).replace(/[\\/]+$/, '');
  const f = fold ? file.toLowerCase() : file;
  if (f === r || !f.startsWith(r) || !/^[\\/]/.test(f.slice(r.length))) return undefined;
  return file.slice(r.length + 1).replace(/\\/g, '/');
};

/** The file's path inside the repository, as Git names it. */
export function rel(root: vscode.Uri, file: vscode.Uri): string {
  const direct = within(root.fsPath, file.fsPath);
  if (direct !== undefined) return direct;
  // Opened through a symbolic link: Git gives the root's real path.
  const real = within(realPath(root.fsPath), realPath(file.fsPath));
  if (real !== undefined) return real;
  throw new Error(`${file.fsPath} is outside the repository at ${root.fsPath}.`);
}

/** Whether a file is inside the repository. */
export function inRepo(root: vscode.Uri, file: vscode.Uri): boolean {
  try {
    rel(root, file);
    return true;
  } catch {
    return false;
  }
}

export const SHOW_SCHEME = 'openapi-breaking-changes-git';

/**
 * The repository that holds `file`. Throws GitUnavailable with a message for people when
 * there is none or Git can't run (Restricted Mode, no git).
 */
export async function repoFor(file: vscode.Uri): Promise<Repo> {
  if (!vscode.workspace.isTrusted) throw new GitUnavailable("Comparing with Git needs a trusted workspace: Git doesn't run in Restricted Mode.");
  if (file.scheme !== 'file') throw new GitUnavailable('Comparing with Git works for files on disk.');
  const api = await gitApi();
  if (api) {
    let repo = api.getRepository(file);
    // Right after startup Git is still discovering repositories.
    for (let waited = 0; !repo && api.state !== 'initialized' && waited < 10_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
      repo = api.getRepository(file);
    }
    if (repo) {
      const r = repo;
      return {
        root: r.rootUri,
        show: async (ref, f) => {
          if (!validRef(ref)) throw new Error(`Not a valid ref: ${ref}`);
          try {
            return await r.show(ref, f.fsPath);
          } catch {
            // The API's errors don't say why; the CLI's do.
            return run(['show', `${ref}:${rel(r.rootUri, f)}`], r.rootUri.fsPath);
          }
        },
        refs: async () => toItems(r.getRefs ? await r.getRefs() : (r.state.refs ?? []), r.state.HEAD),
        uriAt: (f, ref) => (api.toGitUri ? api.toGitUri(f, ref) : showUri(f, ref, r.rootUri)),
        lastTag: () => lastTag(r.rootUri),
        resolve: (ref) => resolve(r.rootUri, ref),
        onDidChange: r.state.onDidChange,
      };
    }
  }
  // No Git extension (disabled, or another editor): the CLI.
  let top: string;
  try {
    top = (await run(['rev-parse', '--show-toplevel'], vscode.Uri.joinPath(file, '..').fsPath)).trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/.test(msg)) throw new GitUnavailable('Git is not installed or not on PATH.');
    throw new GitUnavailable(`${file.path.split('/').pop()} is not in a Git repository.`);
  }
  const root = vscode.Uri.file(top);
  return {
    root,
    show: (ref, f) => {
      if (!validRef(ref)) return Promise.reject(new Error(`Not a valid ref: ${ref}`));
      return run(['show', `${ref}:${rel(root, f)}`], root.fsPath);
    },
    refs: async () => {
      const out = await run(['for-each-ref', '--format=%(refname)%09%(objectname:short)', 'refs/heads', 'refs/tags', 'refs/remotes'], root.fsPath);
      const items: RefItem[] = [{ name: 'HEAD', kind: 'head' }];
      for (const line of out.split('\n')) {
        const [full, commit] = line.split('\t');
        if (!full) continue;
        if (full.startsWith('refs/heads/')) items.push({ name: full.slice(11), kind: 'branch', commit });
        else if (full.startsWith('refs/tags/')) items.push({ name: full.slice(10), kind: 'tag', commit });
        else if (full.startsWith('refs/remotes/') && !full.endsWith('/HEAD')) items.push({ name: full.slice(13), kind: 'remote', commit });
      }
      return items;
    },
    uriAt: (f, ref) => showUri(f, ref, root),
    lastTag: () => lastTag(root),
    resolve: (ref) => resolve(root, ref),
  };
}

async function resolve(root: vscode.Uri, ref: string): Promise<string | undefined> {
  if (!validRef(ref)) return undefined;
  try {
    return (await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root.fsPath)).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function lastTag(root: vscode.Uri): Promise<string | undefined> {
  try {
    const t = (await run(['describe', '--tags', '--abbrev=0', 'HEAD'], root.fsPath)).trim();
    return t && validRef(t) ? t : undefined;
  } catch {
    return undefined; // no tags
  }
}

function toItems(refs: GitRef[], head?: GitRef): RefItem[] {
  const items: RefItem[] = [{ name: 'HEAD', kind: 'head', commit: head?.commit }];
  for (const r of refs) {
    if (!r.name) continue;
    if (r.type === 0) items.push({ name: r.name, kind: 'branch', commit: r.commit });
    else if (r.type === 1) {
      if (!r.name.endsWith('/HEAD')) items.push({ name: r.name, kind: 'remote', commit: r.commit });
    } else if (r.type === 2) items.push({ name: r.name, kind: 'tag', commit: r.commit });
  }
  return items;
}

function showUri(file: vscode.Uri, ref: string, root: vscode.Uri) {
  return vscode.Uri.from({ scheme: SHOW_SCHEME, path: file.path, query: JSON.stringify({ ref, root: root.toString() }) });
}

/** Serves `showUri` documents (when the Git extension isn't there to do it). */
export function registerShowProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SHOW_SCHEME, {
    provideTextDocumentContent: async (uri) => {
      const { ref, root } = JSON.parse(uri.query) as { ref: string; root: string };
      const r = vscode.Uri.parse(root);
      if (!validRef(ref) || !vscode.workspace.isTrusted) return '';
      return run(['show', `${ref}:${rel(r, uri.with({ scheme: 'file', query: '' }))}`], r.fsPath);
    },
  });
}

/**
 * The file isn't there at that ref (it is newer): `git show` says the path does not exist
 * in it. A ref that names nothing is another error.
 */
export function missingAtRef(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /does not exist in|exists on disk, but not in/i.test(m);
}
