import * as vscode from 'vscode';
import { readIgnore, type CompareOptions, type IgnoreRule, type Level, type Policy } from './core';

export const SECTION = 'openapiBreakingChanges';

export function policy(scope?: vscode.Uri): Policy {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return { ignore: readIgnore(c.get('ignore')), warningsAsErrors: c.get('treatWarningsAsErrors') === true };
}

export function compareOptions(scope?: vscode.Uri): CompareOptions {
  const v = vscode.workspace.getConfiguration(SECTION, scope).get('detectMovedEndpoints');
  return { renames: v === 'off' || v === 'operationId' ? v : 'similar' };
}

export function baseRef(scope?: vscode.Uri): string {
  const v = vscode.workspace.getConfiguration(SECTION, scope).get('baseRef');
  return typeof v === 'string' ? v.trim() : '';
}

export function problemsLevel(scope?: vscode.Uri): Level {
  const v = vscode.workspace.getConfiguration(SECTION, scope).get('problemsLevel');
  return v === 'error' || v === 'info' ? v : 'warning';
}

/** Where an ignore rule goes: the folder of the spec, the workspace, or the user settings. */
export function ignoreTarget(scope?: vscode.Uri): { target: vscode.ConfigurationTarget; name: string } {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return { target: vscode.ConfigurationTarget.Global, name: 'user' };
  // In a multi-root workspace each folder keeps its own rules.
  if (folders.length > 1 && scope && vscode.workspace.getWorkspaceFolder(scope)) return { target: vscode.ConfigurationTarget.WorkspaceFolder, name: 'folder' };
  return { target: vscode.ConfigurationTarget.Workspace, name: 'workspace' };
}

/**
 * Adds an ignore rule. `user` puts it in the user settings whatever the workspace, for
 * Restricted Mode, where the workspace's own rules are not applied.
 */
export async function addIgnore(rules: IgnoreRule | string | Array<IgnoreRule | string>, scope?: vscode.Uri, user = false): Promise<string> {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const { target, name } = user ? { target: vscode.ConfigurationTarget.Global, name: 'user' } : ignoreTarget(scope);
  // Add to what that target holds, not the merged value (which includes user settings).
  const info = c.inspect<unknown>('ignore');
  const held = target === vscode.ConfigurationTarget.WorkspaceFolder ? info?.workspaceFolderValue : target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
  const current = Array.isArray(held) ? held : [];
  const have = new Set(current.map((x) => JSON.stringify(x)));
  const fresh = (Array.isArray(rules) ? rules : [rules]).filter((r) => {
    const k = JSON.stringify(r);
    return !have.has(k) && have.add(k);
  });
  if (fresh.length) await c.update('ignore', [...current, ...fresh], target);
  return name;
}

/**
 * Above this many characters a spec is compared again when saved, not as you type. YAML
 * takes several times longer to read than JSON.
 */
export function liveLimit(doc: vscode.TextDocument): number {
  return doc.languageId === 'json' || doc.languageId === 'jsonc' || /\.json$/i.test(doc.uri.path) ? 3_000_000 : 1_000_000;
}

/** The length of a document's text, without building the string. */
export function sizeOf(doc: vscode.TextDocument): number {
  return doc.lineCount ? doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end) : 0;
}