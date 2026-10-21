/**
 * Whether a document is an OpenAPI or Swagger spec, by content: a top-level `openapi:` or
 * `swagger:` key in YAML, or a top-level `"openapi"` / `"swagger"` property in JSON. The
 * whole text is looked at: specs with sorted keys have `openapi` after `components`.
 */
export function looksLikeSpec(text: string): boolean {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/^\s*\{/.test(t)) return jsonTopLevel(t);
  if (/^(?:openapi|swagger)\s*:\s*['"]?\d/m.test(t)) return true;
  // YAML with the key quoted.
  return /^["'](?:openapi|swagger)["']\s*:\s*['"]?\d/m.test(t);
}

/** A JSON object with an `openapi` or `swagger` key of its own (not one nested deeper). */
function jsonTopLevel(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 34 /* " */) {
      const start = i + 1;
      let j = start;
      for (;;) {
        j = t.indexOf('"', j);
        if (j < 0) return false;
        let k = j - 1;
        while (t.charCodeAt(k) === 92 /* \ */) k--;
        if ((j - 1 - k) % 2 === 0) break;
        j++;
      }
      if (depth === 1 && j - start === 7) {
        const key = t.slice(start, j);
        if ((key === 'openapi' || key === 'swagger') && /^\s*:\s*"?\d/.test(t.slice(j + 1, j + 64))) return true;
      }
      i = j;
    } else if (c === 123 /* { */ || c === 91 /* [ */) depth++;
    else if (c === 125 /* } */ || c === 93 /* ] */) {
      if (--depth <= 0) return false;
    }
  }
  return false;
}
