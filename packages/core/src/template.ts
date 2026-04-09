/**
 * Template parser for `#{name}` tokens.
 *
 * Used by every editable text field on a node (URL, header values, body) to:
 *   1. Discover which input pins the node should expose
 *   2. Substitute pin values into the literal string at execution time
 *
 * Token grammar:
 *   #{ident}              → input pin "ident"
 *   #{ident.path.to}      → input pin "ident", consumer reads `.path.to` from value
 *
 * `ident` matches `[A-Za-z_][A-Za-z0-9_]*`. Dotted suffix is captured but does
 * NOT influence the pin name — only the root identifier becomes a pin.
 */

const TOKEN_RE = /#\{([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

export interface TemplateToken {
  /** Pin name (the root identifier). */
  name: string;
  /** Optional dotted access path after the root, e.g. ["user", "id"]. */
  path: string[];
  /** Full match including the `#{...}` wrapper. */
  raw: string;
}

/** Extract every token from a string. Order preserved, duplicates kept. */
export function parseTemplate(input: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  for (const m of input.matchAll(TOKEN_RE)) {
    tokens.push({
      name: m[1]!,
      path: m[2] ? m[2].slice(1).split(".") : [],
      raw: m[0],
    });
  }
  return tokens;
}

/** Unique pin names referenced by a string. */
export function inputPinsFor(input: string): string[] {
  const seen = new Set<string>();
  for (const t of parseTemplate(input)) seen.add(t.name);
  return [...seen];
}

/**
 * Substitute pin values into a template string.
 * `values` is keyed by pin name; dotted suffixes drill into the value.
 */
export function renderTemplate(input: string, values: Record<string, unknown>): string {
  return input.replace(TOKEN_RE, (_full, name: string, dotted: string) => {
    const root = values[name];
    if (root === undefined) return "";
    if (!dotted) return stringify(root);
    let cur: unknown = root;
    for (const seg of dotted.slice(1).split(".")) {
      if (cur == null || typeof cur !== "object") return "";
      cur = (cur as Record<string, unknown>)[seg];
    }
    return stringify(cur);
  });
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
