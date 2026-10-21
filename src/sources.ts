import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { codeSpan, type Reader } from './core';
import { inRepo, repoFor, type Repo } from './git';

/** How to get a side back after a window reload. */
export type Restore =
  | { kind: 'doc'; uri: string }
  | { kind: 'git'; uri: string; ref: string }
  | { kind: 'text'; label: string; text: string; path: string; scope?: string };

/** One side of a comparison: a spec's text, and how to read and open the files it references. */
export interface SpecSource {
  label: string;
  /** How release notes name this version: "`v1.2.0`", "the working copy". */
  name: string;
  detail?: string;
  text: string;
  /** POSIX path the engine sees; relative `$ref`s resolve against it. */
  path: string;
  read: Reader;
  /** The editor URI for a path the engine reported, or undefined when it can't be opened. */
  uriFor(path: string): vscode.Uri | undefined;
  /** A document whose edits should update the comparison. */
  live?: vscode.Uri;
  /** The file on disk this side is a version of, whose folder's settings apply. */
  scope?: vscode.Uri;
  restore: Restore;
  reload(): Promise<SpecSource>;
}

const decoder = new TextDecoder();
const base = (u: vscode.Uri) => u.path.split('/').pop() || u.path;

/**
 * Referenced files are read only from the spec's folder (and below) or from inside the
 * workspace, whatever the `$ref` says.
 */
export function allowed(main: vscode.Uri, path: string): boolean {
  if (main.scheme === 'untitled') return false;
  const dir = main.path.slice(0, main.path.lastIndexOf('/') + 1);
  if (dir && path.startsWith(dir)) return true;
  // git: and other read-only views of workspace files carry the file's own path.
  const inWorkspace = (u: vscode.Uri) => vscode.workspace.getWorkspaceFolder(u)?.uri.scheme === u.scheme;
  return inWorkspace(main.with({ path, query: '', fragment: '' })) || inWorkspace(vscode.Uri.from({ scheme: 'file', path }));
}

/** Larger files are not read: no spec is that big, and a device or a FIFO never ends. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** A file's text: the open document's, else the file's, when it is a regular file of a sane size. */
async function readUri(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  const st = await vscode.workspace.fs.stat(uri);
  if (!(st.type & vscode.FileType.File)) throw new Error(`${base(uri)} is not a file.`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${base(uri)} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

const real = async (p: string) => {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return undefined;
  }
};

/**
 * A file a `$ref` names, read only where `allowed` says. On disk the check is made again on
 * where the path really leads, so a symbolic link can't reach outside.
 */
async function readReferenced(main: vscode.Uri, p: string): Promise<string | undefined> {
  if (!allowed(main, p)) return undefined;
  const uri = main.with({ path: p });
  if (uri.scheme === 'file' && !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) {
    const target = await real(uri.fsPath);
    if (!target) return undefined;
    const under = async (dir: string) => {
      const r = await real(dir);
      return !!r && (target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
    };
    const roots = [vscode.Uri.joinPath(main, '..').fsPath, ...(vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath)];
    let ok = false;
    for (const r of roots) if ((ok = await under(r))) break;
    if (!ok) return undefined;
  }
  try {
    return await readUri(uri);
  } catch {
    return undefined;
  }
}

/** A document on disk (or any file system), following its unsaved edits. */
export async function fromDocument(uri: vscode.Uri): Promise<SpecSource> {
  const text = await readUri(uri);
  const untitled = uri.scheme === 'untitled';
  return {
    label: untitled ? uri.path : base(uri),
    name: codeSpan(untitled ? uri.path : base(uri)),
    detail: untitled ? 'unsaved' : vscode.workspace.asRelativePath(uri),
    text,
    path: uri.path,
    read: (p) => readReferenced(uri, p),
    uriFor: (p) => uri.with({ path: p }),
    live: uri,
    scope: uri,
    restore: { kind: 'doc', uri: uri.toString() },
    reload: () => fromDocument(uri),
  };
}

/** The file as of a Git ref. Referenced files are read at the same ref. */
export async function fromGit(file: vscode.Uri, ref: string, repo?: Repo): Promise<SpecSource> {
  const r = repo ?? (await repoFor(file));
  const text = await r.show(ref, file);
  const inside = (p: string) => inRepo(r.root, file.with({ path: p }));
  return {
    label: `${base(file)} (${shortRef(ref)})`,
    name: codeSpan(shortRef(ref)),
    detail: `${vscode.workspace.asRelativePath(file)} at ${shortRef(ref)}`,
    text,
    path: file.path,
    read: async (p) => (inside(p) ? r.show(ref, file.with({ path: p })) : undefined),
    uriFor: (p) => r.uriAt(file.with({ path: p }), ref),
    scope: file,
    restore: { kind: 'git', uri: file.toString(), ref },
    reload: () => fromGit(file, ref),
  };
}

/** `23e29a0971e9…` → `23e29a09`, as VS Code's own diff tabs show commits. */
export const shortRef = (r: string) => (r === '~' || r === '' ? 'index' : r.replace(/^([0-9a-f]{8})[0-9a-f]{32}$/, '$1'));

/**
 * One side of an open diff editor: a file, or a `git:` revision (Source Control, Timeline,
 * pull requests). Referenced files are read the same way, by swapping the path in the URI.
 */
export async function fromDiffSide(uri: vscode.Uri, label?: string): Promise<SpecSource> {
  if (uri.scheme === 'file' || uri.scheme === 'untitled' || uri.scheme === 'vscode-remote') return fromDocument(uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  const sibling = (p: string) => {
    if (uri.scheme === 'git') {
      try {
        const q = JSON.parse(uri.query) as Record<string, unknown>;
        return uri.with({ path: p, query: JSON.stringify({ ...q, path: vscode.Uri.from({ scheme: 'file', path: p }).fsPath }) });
      } catch {
        return undefined;
      }
    }
    return uri.with({ path: p });
  };
  const gitRef = (() => {
    if (uri.scheme !== 'git') return undefined;
    try {
      return (JSON.parse(uri.query) as { ref?: string }).ref;
    } catch {
      return undefined;
    }
  })();
  const name = label ?? (gitRef !== undefined ? `${base(uri)} (${shortRef(gitRef)})` : base(uri));
  const text = doc.getText();
  // A `git:` view of a workspace file is that file, as far as settings go.
  const scope = uri.scheme === 'git' ? uri.with({ scheme: 'file', query: '', fragment: '' }) : undefined;
  return {
    label: name,
    name: codeSpan(gitRef !== undefined ? shortRef(gitRef) : name),
    detail: gitRef !== undefined ? `${vscode.workspace.asRelativePath(uri.with({ scheme: 'file', query: '' }))} at ${shortRef(gitRef)}` : undefined,
    text,
    path: uri.path,
    read: async (p) => {
      const s = allowed(uri, p) ? sibling(p) : undefined;
      if (!s) return undefined;
      try {
        return (await vscode.workspace.openTextDocument(s)).getText();
      } catch {
        return undefined;
      }
    },
    uriFor: (p) => sibling(p),
    scope,
    restore: { kind: 'text', label: name, text: text.length <= 5_000_000 ? text : '', path: uri.path, scope: scope?.toString() },
    reload: () => fromDiffSide(uri, label),
  };
}

/** A side that only exists as text (restored after a reload). */
export function fromText(label: string, text: string, path: string, scope?: vscode.Uri): SpecSource {
  return {
    label,
    name: codeSpan(label),
    text,
    path,
    read: async () => undefined,
    uriFor: () => undefined,
    scope,
    restore: { kind: 'text', label, text, path, scope: scope?.toString() },
    reload: async () => fromText(label, text, path, scope),
  };
}

export async function fromRestore(r: Restore): Promise<SpecSource> {
  if (r.kind === 'doc') return fromDocument(vscode.Uri.parse(r.uri));
  if (r.kind === 'git') return fromGit(vscode.Uri.parse(r.uri), r.ref);
  return fromText(r.label, r.text, r.path, r.scope ? vscode.Uri.parse(r.scope) : undefined);
}

/**
 * Two sides with the same name (`v1/openapi.yaml` and `v2/openapi.yaml`) are named by the
 * shortest end of their paths that tells them apart.
 */
export function distinguish(a: SpecSource, b: SpecSource) {
  if (a.label !== b.label || !a.detail || !b.detail || a.detail === b.detail) return;
  const pa = a.detail.split('/');
  const pb = b.detail.split('/');
  for (let k = 2; k <= Math.max(pa.length, pb.length); k++) {
    const x = pa.slice(-k).join('/');
    const y = pb.slice(-k).join('/');
    if (x === y) continue;
    a.label = x;
    b.label = y;
    a.name = codeSpan(x);
    b.name = codeSpan(y);
    return;
  }
}
