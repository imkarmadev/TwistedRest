/**
 * Evaluate a Zod schema written as text into a real ZodTypeAny.
 *
 * The user authors the schema in a textarea using `z.object({...})`-style
 * code; we wrap it in a Function expression with `z` injected as the only
 * free variable. Errors return null so the inspector can show "invalid".
 *
 * Safety note: this evaluates user-authored code in the renderer. The user
 * is the only author and the code only sees `z`, but real `eval` is still
 * possible via `z.constructor.constructor(...)` etc. — acceptable for a
 * single-user desktop tool. Revisit if we ever import schemas from the
 * network.
 */

import { z, type ZodTypeAny } from "zod";

export interface EvalResult {
  ok: boolean;
  schema?: ZodTypeAny;
  error?: string;
}

export function evalZodSchema(src: string): EvalResult {
  const trimmed = src.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("z", `return (${trimmed});`);
    const result = fn(z);
    if (!result || typeof result !== "object" || !("_def" in result)) {
      return { ok: false, error: "expression did not produce a Zod schema" };
    }
    return { ok: true, schema: result as ZodTypeAny };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
