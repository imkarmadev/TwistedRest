/**
 * Generate Zod schema source code from a sample JSON value.
 *
 * Walks the JSON structure recursively and emits a string of Zod source
 * (e.g. `z.object({ id: z.number(), name: z.string() })`) that the user
 * can paste into a node's response schema editor.
 *
 * Heuristics:
 *   - `null` becomes `z.null()` — caller can swap to .nullable() if desired
 *   - Arrays infer the element type from the first element. Empty arrays
 *     become `z.array(z.unknown())`
 *   - Objects keep field order from the source JSON
 *   - Mixed-type arrays fall back to `z.array(z.unknown())`
 *
 * The output is pretty-printed with 2-space indentation so it drops
 * straight into the schema textarea looking sensible.
 */

export interface InferOptions {
  /** Indent step for pretty-printing. Defaults to 2 spaces. */
  indent?: string;
}

export function zodFromJson(value: unknown, options: InferOptions = {}): string {
  const indent = options.indent ?? "  ";
  return walk(value, 0, indent);
}

/**
 * Convenience: parse a JSON string and infer.
 * Returns null on parse failure.
 */
export function zodFromJsonString(json: string, options: InferOptions = {}): string | null {
  try {
    const parsed = JSON.parse(json);
    return zodFromJson(parsed, options);
  } catch {
    return null;
  }
}

function walk(value: unknown, depth: number, indent: string): string {
  if (value === null) return "z.null()";
  if (typeof value === "string") return "z.string()";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "z.number().int()" : "z.number()";
  }
  if (typeof value === "boolean") return "z.boolean()";

  if (Array.isArray(value)) {
    if (value.length === 0) return "z.array(z.unknown())";
    // Use the first element's shape. If elements vary, the user can adjust.
    const elem = walk(value[0], depth + 1, indent);
    return `z.array(${elem})`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "z.object({})";

    const pad = indent.repeat(depth + 1);
    const closingPad = indent.repeat(depth);
    const lines = keys.map((k) => {
      const safeKey = isSafeKey(k) ? k : JSON.stringify(k);
      return `${pad}${safeKey}: ${walk(obj[k], depth + 1, indent)},`;
    });
    return `z.object({\n${lines.join("\n")}\n${closingPad}})`;
  }

  return "z.unknown()";
}

function isSafeKey(k: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
}
