import type { Locs, ParseResult } from './parse';

/**
 * A JSON parser that remembers where every property and array item starts, so a change
 * can point at its line. Much faster than a YAML parser on multi-megabyte specs.
 * Duplicate keys: the last one wins, as in JSON.parse.
 */
export function parseJson(text: string): ParseResult {
  const locs: Locs = new WeakMap();
  let i = 0;
  const n = text.length;

  const fail = (msg: string, at = i): never => {
    throw new JsonError(msg, at);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else break;
    }
  };
  const str = (): string => {
    const start = ++i; // after the opening quote
    let escaped = false;
    for (;;) {
      if (i >= n) fail('Unterminated string', start - 1);
      const c = text.charCodeAt(i);
      if (c === 34) break;
      if (c === 92) {
        escaped = true;
        i += 2;
        continue;
      }
      if (c < 32) fail('Control character in string');
      i++;
    }
    const raw = text.slice(start, i);
    i++;
    if (!escaped) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return fail('Invalid escape in string', start);
    }
  };
  const num = (): number => {
    const start = i;
    if (text[i] === '-') i++;
    while (i < n && /[0-9.eE+-]/.test(text[i])) i++;
    const v = Number(text.slice(start, i));
    if (text.slice(start, i) === '' || Number.isNaN(v)) fail('Invalid number', start);
    return v;
  };
  const word = (w: string, v: unknown) => {
    if (text.startsWith(w, i)) {
      i += w.length;
      return v;
    }
    return fail(`Unexpected ${JSON.stringify(text[i])}`);
  };

  const value = (depth: number): unknown => {
    if (depth > 2000) fail('Nested too deeply');
    ws();
    const c = text[i];
    if (c === '{') {
      const obj: Record<string, unknown> = {};
      const at = new Map<string, number>();
      locs.set(obj, at);
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected a property name in double quotes');
        const keyAt = i;
        const key = str();
        ws();
        if (text[i] !== ':') fail('Expected ":" after a property name');
        i++;
        const v = value(depth + 1);
        // Own property even for "__proto__".
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        at.set(key, keyAt);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      const arr: unknown[] = [];
      const at = new Map<string, number>();
      locs.set(arr, at);
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        ws();
        at.set(String(arr.length), i);
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail('Expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (c === 't') return word('true', true);
    if (c === 'f') return word('false', false);
    if (c === 'n') return word('null', null);
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    return fail(i >= n ? 'Unexpected end of the document' : `Unexpected ${JSON.stringify(c)}`);
  };

  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    const root = value(0);
    ws();
    if (i < n) fail('Unexpected text after the document');
    return { value: root, locs };
  } catch (e) {
    if (e instanceof JsonError) return { locs, error: { message: e.message, offset: e.offset } };
    throw e;
  }
}

class JsonError extends Error {
  constructor(
    message: string,
    public offset: number,
  ) {
    super(message);
  }
}
