export { compareSpecs, pathKey, METHODS, MOVE_THRESHOLD, MAX_MOVE_PAIRS, type Change, type CompareOptions, type RenameDetection } from './diff';
export { looksLikeSpec } from './detect';
export { codeSpan, mdText } from './md';
export { endpointLabel, schemaPropertyName, sharedMessage, toMarkdown, toReleaseNotes, releaseSection, type ReleaseNotesInfo } from './markdown';
export { parseText, parseYaml, lineStarts, position } from './parse';
export { parseJson } from './json';
export { applyPolicy, count, readIgnore, matches, pathMatcher, escapePath, idMatcher, atLeast, type Counts, type IgnoreRule, type Policy } from './policy';
export { allRules, kindId, SCHEMA_RULES, LEVEL_ORDER, type Level, type Rule } from './rules';
export { loadSpec, resolvePath, type Loc, type LoadError, type Reader, type Spec } from './spec';

import { compareSpecs, type Change, type CompareOptions } from './diff';
import { loadSpec, type LoadError, type Reader, type Spec } from './spec';

export interface Side {
  text: string;
  /** POSIX path of the file; relative `$ref`s resolve against it. */
  path: string;
  read?: Reader;
}

export interface Result {
  changes: Change[];
  /** Per side: why it couldn't be read. Both undefined when the comparison ran. */
  errors: { old?: LoadError; new?: LoadError };
  warnings: string[];
  /** What the comparison itself left out, such as moved operations when there are too many. */
  notes: string[];
  /** The files each side was read from: the spec and every file its `$ref`s reached. */
  files: { old: string[]; new: string[] };
  versions: { old?: string; new?: string };
  /** `info.version` of each side. */
  apiVersions: { old?: string; new?: string };
  ms: number;
}

/** Loads both sides and compares them. Never throws for bad input: errors come back in the result. */
export async function compare(oldSide: Side, newSide: Side, options?: CompareOptions): Promise<Result> {
  const t = Date.now();
  const [a, b] = await Promise.all([cachedLoad(oldSide), cachedLoad(newSide)]);
  const versions = { old: a.spec?.versionText, new: b.spec?.versionText };
  const apiVersions = { old: infoVersion(a.spec), new: infoVersion(b.spec) };
  const files = { old: a.spec ? [...a.spec.docs.keys()] : [oldSide.path], new: b.spec ? [...b.spec.docs.keys()] : [newSide.path] };
  if (!a.spec || !b.spec) return { changes: [], errors: { old: a.error, new: b.error }, warnings: [], notes: [], files, versions, apiVersions, ms: Date.now() - t };
  const notes: string[] = [];
  const changes = compareSpecs(a.spec, b.spec, options, notes);
  const warnings = [...new Set([...prefixed('Old', a.spec), ...prefixed('New', b.spec)])];
  return { changes, errors: {}, warnings, notes, files, versions, apiVersions, ms: Date.now() - t };
}

function infoVersion(s?: Spec): string | undefined {
  const v = (s?.main.root as { info?: { version?: unknown } } | undefined)?.info?.version;
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * The last few single-file specs, by path and text: re-comparing after an edit to one side
 * doesn't parse the other again. Specs that reference other files are always re-read.
 */
const cache: Array<{ path: string; text: string; spec: Spec }> = [];
/** Characters of spec text the cache may hold (a parsed spec takes several times that). */
const CACHE_CHARS = 24_000_000;
async function cachedLoad(side: Side): Promise<{ spec?: Spec; error?: LoadError }> {
  const hit = cache.find((c) => c.path === side.path && c.text === side.text);
  if (hit) return { spec: hit.spec };
  const r = await loadSpec(side.text, side.path, side.read);
  if (r.spec && r.spec.docs.size === 1 && !r.spec.warnings.length && side.text.length <= CACHE_CHARS / 2) {
    cache.unshift({ path: side.path, text: side.text, spec: r.spec });
    let total = 0;
    const keep = cache.findIndex((c, i) => (total += c.text.length) > CACHE_CHARS || i >= 4);
    if (keep >= 0) cache.length = keep;
  }
  return r;
}

/** Lets go of the parsed specs kept for the next comparison. */
export function clearCache() {
  cache.length = 0;
}

function prefixed(side: string, s: Spec) {
  return s.warnings.map((w) => `${side}: ${w}`);
}
export { guessOrder, compareVersions, versionParts, type Candidate } from './order';
