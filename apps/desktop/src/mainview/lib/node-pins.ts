/**
 * Computes the pin layout for a node from its `data`.
 *
 * Single source of truth used by both:
 *   - the node renderer (to draw <Handle> elements)
 *   - flow-canvas (to detect when pins disappear so dangling edges can be culled)
 *
 * For an HttpRequest node:
 *   inputs:   exec-in    plus  one "in:<name>" per unique #{name} in url+headers+body
 *   outputs:  exec-out   plus  one "out:<field>" per top-level field of the
 *             response Zod schema (or "out:value" if non-object).
 */

import { inputPinsFor, pinsFromSchema, type DataType } from "@twistedflow/core";
import { evalZodSchema } from "./eval-schema";

export interface ComputedPin {
  /** Stable handle id passed to React Flow's <Handle id="..." />. */
  id: string;
  side: "left" | "right";
  label: string;
  kind: "exec" | "data";
  dataType?: DataType;
}

export interface ComputedPins {
  inputs: ComputedPin[];
  outputs: ComputedPin[];
}

export interface HttpRequestData {
  method?: string;
  url?: string;
  headers?: Array<{ key: string; value: string; enabled?: boolean }>;
  body?: string;
  responseSchema?: string;
}

const EXEC_IN: ComputedPin = { id: "exec-in", side: "left", label: "exec", kind: "exec" };
const EXEC_OUT: ComputedPin = { id: "exec-out", side: "right", label: "exec", kind: "exec" };

export function computeHttpRequestPins(data: HttpRequestData): ComputedPins {
  // ── Input pins from #{name} tokens ───────────────────────────
  const tokenSources: string[] = [];
  if (data.url) tokenSources.push(data.url);
  if (data.body) tokenSources.push(data.body);
  if (data.headers) {
    for (const h of data.headers) {
      if (h.enabled !== false && h.value) tokenSources.push(h.value);
    }
  }

  const seen = new Set<string>();
  for (const src of tokenSources) {
    for (const name of inputPinsFor(src)) seen.add(name);
  }

  const inputDataPins: ComputedPin[] = [...seen].map((name) => ({
    id: `in:${name}`,
    side: "left",
    label: name,
    kind: "data",
    dataType: "unknown",
  }));

  // ── Output pins from Zod response schema ─────────────────────
  let outputDataPins: ComputedPin[] = [];
  const result = evalZodSchema(data.responseSchema ?? "");
  if (result.ok && result.schema) {
    const descriptors = pinsFromSchema(result.schema);
    outputDataPins = descriptors.map((d) => ({
      id: `out:${d.id}`,
      side: "right",
      label: d.label,
      kind: "data",
      dataType: d.dataType,
    }));
  }

  // Fixed output pins — always present
  const statusPin: ComputedPin = {
    id: "out:status",
    side: "right",
    label: "status",
    kind: "data",
    dataType: "number",
  };

  const responseTimePin: ComputedPin = {
    id: "out:responseTime",
    side: "right",
    label: "responseTime",
    kind: "data",
    dataType: "number",
  };

  const responseHeadersPin: ComputedPin = {
    id: "out:responseHeaders",
    side: "right",
    label: "responseHeaders",
    kind: "data",
    dataType: "object",
  };

  return {
    inputs: [EXEC_IN, ...inputDataPins],
    outputs: [EXEC_OUT, statusPin, responseTimePin, responseHeadersPin, ...outputDataPins],
  };
}

/** Pins for the Start node. Just one exec output. */
export function computeStartPins(): ComputedPins {
  return { inputs: [], outputs: [EXEC_OUT] };
}

/**
 * Pins for an EnvVar node — single string-typed output pin labelled with
 * the variable key. No exec pins (it's a pure data node).
 */
export function computeEnvVarPins(varKey?: string): ComputedPins {
  return {
    inputs: [],
    outputs: [
      {
        id: "out:value",
        side: "right",
        label: varKey || "value",
        kind: "data",
        dataType: "string",
      },
    ],
  };
}

/**
 * Static pin set for a Break-Object node — one input "object" pin.
 * The output pins are computed dynamically inside the node component
 * (they depend on the connected source schema), so this only seeds the
 * input side. Used by edge culling to know which fixed pins exist.
 */
export function computeBreakObjectPins(): ComputedPins {
  return {
    inputs: [
      {
        id: "in:object",
        side: "left",
        label: "object",
        kind: "data",
        dataType: "object",
      },
    ],
    outputs: [],
  };
}

/**
 * Match node — switch/case routing. exec-in + value input on left;
 * one exec output per case + a default on right.
 */
/**
 * Set Variable — exec-chain node that writes a runtime variable.
 */
export function computeSetVariablePins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "unknown" },
    ],
    outputs: [EXEC_OUT],
  };
}

/**
 * Get Variable — data node that reads a runtime variable.
 */
export function computeGetVariablePins(varName?: string): ComputedPins {
  return {
    inputs: [],
    outputs: [
      {
        id: "out:value",
        side: "right",
        label: varName || "value",
        kind: "data",
        dataType: "unknown",
      },
    ],
  };
}

export function computeMatchPins(
  cases: Array<{ value: string; label?: string }> = [],
): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      ...cases.map<ComputedPin>((c, i) => ({
        id: `exec-case:${i}`,
        side: "right",
        label: c.label || c.value || `case ${i}`,
        kind: "exec",
      })),
      { id: "exec-default", side: "right", label: "default", kind: "exec" },
    ],
  };
}

/**
 * Function node — user-authored TS transform. Typed input/output pins
 * declared in the inspector. Pure data, no exec pins.
 */
export function computeFunctionPins(
  inputs: PayloadField[] = [],
  outputs: PayloadField[] = [],
): ComputedPins {
  return {
    inputs: inputs.map((f) => ({
      id: `in:${f.key}`,
      side: "left",
      label: f.key || "(unnamed)",
      kind: "data",
      dataType: f.type,
    })),
    outputs: outputs.map((f) => ({
      id: `out:${f.key}`,
      side: "right",
      label: f.key || "(unnamed)",
      kind: "data",
      dataType: f.type,
    })),
  };
}

/**
 * Make Object node — inverse of Break Object. One input data pin per
 * declared field, one output object pin. Field declarations are stored
 * on the node's data and edited in the inspector.
 */
export function computeMakeObjectPins(fields: PayloadField[] = []): ComputedPins {
  return {
    inputs: fields.map((f) => ({
      id: `in:${f.key}`,
      side: "left",
      label: f.key || "(unnamed)",
      kind: "data",
      dataType: f.type,
    })),
    outputs: [
      { id: "out:object", side: "right", label: "object", kind: "data", dataType: "object" },
    ],
  };
}

/**
 * Log node — exec-chain print sink. exec-in / exec-out for control flow,
 * one data input pin (any type) for the value to log.
 */
export function computeLogPins(): ComputedPins {
  return {
    inputs: [
      { id: "exec-in", side: "left", label: "exec", kind: "exec" },
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      { id: "exec-out", side: "right", label: "exec", kind: "exec" },
    ],
  };
}

/**
 * Tap node — pure debug pass-through. Single in, single out, both
 * untyped (the actual color is determined live from the source). Used
 * by edge-culling to know what static pins exist.
 */
export function computeTapPins(): ComputedPins {
  return {
    inputs: [
      { id: "in:value", side: "left", label: "in", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      { id: "out:value", side: "right", label: "out", kind: "data", dataType: "unknown" },
    ],
  };
}

/**
 * Convert node — single typed input, single typed output. Output type
 * tracks the configured target type for visual coloring; input is unknown
 * since you can convert from any source.
 */
export function computeConvertPins(target?: string): ComputedPins {
  const targetType =
    target === "string"
      ? "string"
      : target === "number" || target === "integer"
        ? "number"
        : target === "boolean"
          ? "boolean"
          : target === "json"
            ? "string"
            : "unknown";
  return {
    inputs: [
      { id: "in:value", side: "left", label: "in", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      {
        id: "out:value",
        side: "right",
        label: "out",
        kind: "data",
        dataType: targetType as DataType,
      },
    ],
  };
}

/**
 * Emit Event node — fixed exec pins, plus one input data pin per declared
 * payload field. Payload is the event's typed argument list, configured in
 * the inspector and persisted on the node's data.
 */
export interface PayloadField {
  key: string;
  type: DataType;
}

export function computeEmitEventPins(payload: PayloadField[] = []): ComputedPins {
  return {
    inputs: [
      { id: "exec-in", side: "left", label: "exec", kind: "exec" },
      ...payload.map<ComputedPin>((f) => ({
        id: `in:${f.key}`,
        side: "left",
        label: f.key || "(unnamed)",
        kind: "data",
        dataType: f.type,
      })),
    ],
    outputs: [{ id: "exec-out", side: "right", label: "exec", kind: "exec" }],
  };
}

/**
 * On Event node — fires when a matching Emit Event runs. NO exec input
 * (can't be reached from another node's exec edge); only an exec output
 * that fans out into the listener's branch. Output pins mirror the
 * matching emitter's payload fields.
 */
export function computeOnEventPins(payload: PayloadField[] = []): ComputedPins {
  return {
    inputs: [],
    outputs: [
      { id: "exec-out", side: "right", label: "exec", kind: "exec" },
      ...payload.map<ComputedPin>((f) => ({
        id: `out:${f.key}`,
        side: "right",
        label: f.key || "(unnamed)",
        kind: "data",
        dataType: f.type,
      })),
    ],
  };
}

/**
 * Static pin set for ForEach nodes (both sequential and parallel — they
 * share the same pin layout). Inputs: exec-in, in:array. Outputs:
 * exec-body, exec-out, out:item, out:index.
 */
export function computeForEachPins(): ComputedPins {
  return {
    inputs: [
      { id: "exec-in", side: "left", label: "exec", kind: "exec" },
      { id: "in:array", side: "left", label: "array", kind: "data", dataType: "array" },
    ],
    outputs: [
      { id: "exec-body", side: "right", label: "body", kind: "exec" },
      { id: "exec-out", side: "right", label: "completed", kind: "exec" },
      { id: "out:item", side: "right", label: "item", kind: "data", dataType: "object" },
      { id: "out:index", side: "right", label: "index", kind: "data", dataType: "number" },
    ],
  };
}

// ── HTTP Server node pins ─────────────────────────────────────────────

/**
 * Route node — multi-route dispatcher. exec-in + 3 data inputs on left;
 * one exec output per route + notFound + data outputs on right.
 */
export function computeRoutePins(
  routes: Array<{ method: string; path: string; label?: string }> = [],
): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:method", side: "left", label: "method", kind: "data", dataType: "string" },
      { id: "in:path", side: "left", label: "path", kind: "data", dataType: "string" },
      { id: "in:query", side: "left", label: "query", kind: "data", dataType: "string" },
    ],
    outputs: [
      ...routes.map<ComputedPin>((r, i) => ({
        id: `exec-route:${i}`,
        side: "right",
        label: r.label || `${r.method} ${r.path}`,
        kind: "exec",
      })),
      { id: "exec-notFound", side: "right", label: "not found", kind: "exec" },
      { id: "out:params", side: "right", label: "params", kind: "data", dataType: "object" },
      { id: "out:query", side: "right", label: "query", kind: "data", dataType: "object" },
    ],
  };
}

/**
 * Parse Body node — data node that parses request body.
 */
export function computeParseBodyPins(): ComputedPins {
  return {
    inputs: [
      { id: "in:body", side: "left", label: "body", kind: "data", dataType: "unknown" },
      { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
    ],
    outputs: [
      { id: "out:parsed", side: "right", label: "parsed", kind: "data", dataType: "unknown" },
      { id: "out:contentType", side: "right", label: "contentType", kind: "data", dataType: "string" },
    ],
  };
}

/**
 * Set Headers node — data node that builds response headers.
 */
export function computeSetHeadersPins(): ComputedPins {
  return {
    inputs: [
      { id: "in:merge", side: "left", label: "merge", kind: "data", dataType: "object" },
    ],
    outputs: [
      { id: "out:headers", side: "right", label: "headers", kind: "data", dataType: "object" },
    ],
  };
}

/**
 * CORS node — branch node for preflight handling.
 */
export function computeCorsPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:method", side: "left", label: "method", kind: "data", dataType: "string" },
      { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
    ],
    outputs: [
      { id: "exec-preflight", side: "right", label: "preflight", kind: "exec" },
      { id: "exec-request", side: "right", label: "request", kind: "exec" },
      { id: "out:corsHeaders", side: "right", label: "corsHeaders", kind: "data", dataType: "object" },
    ],
  };
}

/**
 * Verify Auth node — branch node for auth validation.
 */
export function computeVerifyAuthPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
      { id: "in:secret", side: "left", label: "secret", kind: "data", dataType: "string" },
      { id: "in:validKeys", side: "left", label: "validKeys", kind: "data", dataType: "array" },
    ],
    outputs: [
      { id: "exec-pass", side: "right", label: "pass", kind: "exec" },
      { id: "exec-fail", side: "right", label: "fail", kind: "exec" },
      { id: "out:claims", side: "right", label: "claims", kind: "data", dataType: "object" },
      { id: "out:token", side: "right", label: "token", kind: "data", dataType: "string" },
      { id: "out:error", side: "right", label: "error", kind: "data", dataType: "string" },
    ],
  };
}

/**
 * Rate Limit node — branch node for rate limiting.
 */
export function computeRateLimitPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
      { id: "in:key", side: "left", label: "key", kind: "data", dataType: "string" },
    ],
    outputs: [
      { id: "exec-pass", side: "right", label: "pass", kind: "exec" },
      { id: "exec-limited", side: "right", label: "limited", kind: "exec" },
      { id: "out:remaining", side: "right", label: "remaining", kind: "data", dataType: "number" },
      { id: "out:rateLimitHeaders", side: "right", label: "rateLimitHeaders", kind: "data", dataType: "object" },
    ],
  };
}

/**
 * Cookie node — data node for parsing/setting cookies.
 */
export function computeCookiePins(mode?: string): ComputedPins {
  if (mode === "set") {
    return {
      inputs: [
        { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
      ],
      outputs: [
        { id: "out:setCookieHeaders", side: "right", label: "setCookieHeaders", kind: "data", dataType: "object" },
      ],
    };
  }
  return {
    inputs: [
      { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
    ],
    outputs: [
      { id: "out:cookies", side: "right", label: "cookies", kind: "data", dataType: "object" },
    ],
  };
}

/**
 * Redirect node — exec node that sends a redirect response.
 */
export function computeRedirectPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:url", side: "left", label: "url", kind: "data", dataType: "string" },
    ],
    outputs: [EXEC_OUT],
  };
}

/**
 * Serve Static node — exec node that serves files from disk.
 */
export function computeServeStaticPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:path", side: "left", label: "path", kind: "data", dataType: "string" },
    ],
    outputs: [
      EXEC_OUT,
      { id: "out:filePath", side: "right", label: "filePath", kind: "data", dataType: "string" },
      { id: "out:contentType", side: "right", label: "contentType", kind: "data", dataType: "string" },
      { id: "out:found", side: "right", label: "found", kind: "data", dataType: "boolean" },
    ],
  };
}

// ── System node pins (generic exec nodes) ─────────────────────────────

export function computePrintPins(): ComputedPins {
  return {
    inputs: [EXEC_IN, { id: "in:value", side: "left", label: "value", kind: "data", dataType: "unknown" }],
    outputs: [EXEC_OUT],
  };
}

export function computeShellExecPins(): ComputedPins {
  return {
    inputs: [EXEC_IN, { id: "in:stdin", side: "left", label: "stdin", kind: "data", dataType: "string" }],
    outputs: [
      EXEC_OUT,
      { id: "out:stdout", side: "right", label: "stdout", kind: "data", dataType: "string" },
      { id: "out:stderr", side: "right", label: "stderr", kind: "data", dataType: "string" },
      { id: "out:exitCode", side: "right", label: "exitCode", kind: "data", dataType: "number" },
    ],
  };
}

export function computeFileReadPins(): ComputedPins {
  return {
    inputs: [EXEC_IN],
    outputs: [
      EXEC_OUT,
      { id: "out:content", side: "right", label: "content", kind: "data", dataType: "string" },
      { id: "out:path", side: "right", label: "path", kind: "data", dataType: "string" },
    ],
  };
}

export function computeFileWritePins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:content", side: "left", label: "content", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      EXEC_OUT,
      { id: "out:path", side: "right", label: "path", kind: "data", dataType: "string" },
      { id: "out:bytes", side: "right", label: "bytes", kind: "data", dataType: "number" },
    ],
  };
}

export function computeSleepPins(): ComputedPins {
  return {
    inputs: [EXEC_IN, { id: "in:ms", side: "left", label: "ms", kind: "data", dataType: "number" }],
    outputs: [EXEC_OUT],
  };
}

export function computeExitPins(): ComputedPins {
  return {
    inputs: [EXEC_IN, { id: "in:code", side: "left", label: "code", kind: "data", dataType: "number" }],
    outputs: [],
  };
}

export function computeAssertPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:actual", side: "left", label: "actual", kind: "data", dataType: "unknown" },
      { id: "in:expected", side: "left", label: "expected", kind: "data", dataType: "unknown" },
    ],
    outputs: [EXEC_OUT],
  };
}

export function computeAssertTypePins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "unknown" },
    ],
    outputs: [EXEC_OUT],
  };
}

export function computeHttpListenPins(): ComputedPins {
  return {
    inputs: [EXEC_IN],
    outputs: [
      { id: "exec-request", side: "right", label: "request", kind: "exec" },
      { id: "out:method", side: "right", label: "method", kind: "data", dataType: "string" },
      { id: "out:path", side: "right", label: "path", kind: "data", dataType: "string" },
      { id: "out:query", side: "right", label: "query", kind: "data", dataType: "string" },
      { id: "out:headers", side: "right", label: "headers", kind: "data", dataType: "object" },
      { id: "out:body", side: "right", label: "body", kind: "data", dataType: "unknown" },
    ],
  };
}

export function computeSendResponsePins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:status", side: "left", label: "status", kind: "data", dataType: "number" },
      { id: "in:body", side: "left", label: "body", kind: "data", dataType: "unknown" },
      { id: "in:headers", side: "left", label: "headers", kind: "data", dataType: "object" },
    ],
    outputs: [EXEC_OUT],
  };
}

export function computeRouteMatchPins(): ComputedPins {
  return {
    inputs: [
      { id: "in:method", side: "left", label: "method", kind: "data", dataType: "string" },
      { id: "in:path", side: "left", label: "path", kind: "data", dataType: "string" },
    ],
    outputs: [
      { id: "out:matched", side: "right", label: "matched", kind: "data", dataType: "boolean" },
    ],
  };
}

export function computeIfElsePins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:condition", side: "left", label: "condition", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      { id: "exec-true", side: "right", label: "true", kind: "exec" },
      { id: "exec-false", side: "right", label: "false", kind: "exec" },
    ],
  };
}

export function computeTryCatchPins(): ComputedPins {
  return {
    inputs: [EXEC_IN],
    outputs: [
      { id: "exec-try", side: "right", label: "try", kind: "exec" },
      { id: "exec-catch", side: "right", label: "catch", kind: "exec" },
      EXEC_OUT,
      { id: "out:error", side: "right", label: "error", kind: "data", dataType: "string" },
    ],
  };
}

// ── CLI node pins ─────────────────────────────────────────────────────

export function computeParseArgsPins(): ComputedPins {
  return {
    inputs: [],
    outputs: [
      { id: "out:flags", side: "right", label: "flags", kind: "data", dataType: "object" },
      { id: "out:positional", side: "right", label: "positional", kind: "data", dataType: "array" },
      { id: "out:raw", side: "right", label: "raw", kind: "data", dataType: "array" },
    ],
  };
}

export function computeStdinPins(): ComputedPins {
  return {
    inputs: [EXEC_IN],
    outputs: [
      EXEC_OUT,
      { id: "out:content", side: "right", label: "content", kind: "data", dataType: "string" },
      { id: "out:lines", side: "right", label: "lines", kind: "data", dataType: "array" },
      { id: "out:json", side: "right", label: "json", kind: "data", dataType: "unknown" },
    ],
  };
}

export function computeStderrPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "unknown" },
    ],
    outputs: [EXEC_OUT],
  };
}

export function computePromptPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:message", side: "left", label: "message", kind: "data", dataType: "string" },
    ],
    outputs: [
      EXEC_OUT,
      { id: "out:answer", side: "right", label: "answer", kind: "data", dataType: "string" },
    ],
  };
}

// ── String node pins ──────────────────────────────────────────────────

export function computeRegexPins(mode?: string): ComputedPins {
  const outputs: ComputedPin[] = (() => {
    switch (mode) {
      case "extract":
        return [{ id: "out:matches", side: "right" as const, label: "matches", kind: "data" as const, dataType: "array" as DataType }];
      case "replace":
        return [{ id: "out:result", side: "right" as const, label: "result", kind: "data" as const, dataType: "string" as DataType }];
      case "split":
        return [{ id: "out:parts", side: "right" as const, label: "parts", kind: "data" as const, dataType: "array" as DataType }];
      case "match":
      default:
        return [
          { id: "out:matched", side: "right" as const, label: "matched", kind: "data" as const, dataType: "boolean" as DataType },
          { id: "out:groups", side: "right" as const, label: "groups", kind: "data" as const, dataType: "array" as DataType },
        ];
    }
  })();

  return {
    inputs: [
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "string" },
    ],
    outputs,
  };
}

export function computeTemplatePins(template?: string): ComputedPins {
  const tokenSources: string[] = template ? [template] : [];
  const seen = new Set<string>();
  for (const src of tokenSources) {
    for (const name of inputPinsFor(src)) seen.add(name);
  }

  const inputDataPins: ComputedPin[] = [...seen].map((name) => ({
    id: `in:${name}`,
    side: "left" as const,
    label: name,
    kind: "data" as const,
    dataType: "unknown" as DataType,
  }));

  return {
    inputs: inputDataPins,
    outputs: [
      { id: "out:result", side: "right", label: "result", kind: "data", dataType: "string" },
    ],
  };
}

export function computeEncodeDecodePins(): ComputedPins {
  return {
    inputs: [
      { id: "in:value", side: "left", label: "value", kind: "data", dataType: "string" },
    ],
    outputs: [
      { id: "out:result", side: "right", label: "result", kind: "data", dataType: "string" },
    ],
  };
}

export function computeHashPins(algorithm?: string): ComputedPins {
  const inputs: ComputedPin[] = [
    { id: "in:value", side: "left", label: "value", kind: "data", dataType: "string" },
  ];
  if (algorithm === "hmac-sha256") {
    inputs.push({ id: "in:key", side: "left", label: "key", kind: "data", dataType: "string" });
  }
  return {
    inputs,
    outputs: [
      { id: "out:hash", side: "right", label: "hash", kind: "data", dataType: "string" },
    ],
  };
}

// ── Data transform node pins ──────────────────────────────────────────

export function computeFilterPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:array", side: "left", label: "array", kind: "data", dataType: "array" },
    ],
    outputs: [
      EXEC_OUT,
      { id: "out:result", side: "right", label: "result", kind: "data", dataType: "array" },
      { id: "out:count", side: "right", label: "count", kind: "data", dataType: "number" },
    ],
  };
}

export function computeMapPins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:array", side: "left", label: "array", kind: "data", dataType: "array" },
    ],
    outputs: [
      EXEC_OUT,
      { id: "out:result", side: "right", label: "result", kind: "data", dataType: "array" },
      { id: "out:count", side: "right", label: "count", kind: "data", dataType: "number" },
    ],
  };
}

export function computeMergePins(): ComputedPins {
  return {
    inputs: [
      { id: "in:a", side: "left", label: "a", kind: "data", dataType: "unknown" },
      { id: "in:b", side: "left", label: "b", kind: "data", dataType: "unknown" },
    ],
    outputs: [
      { id: "out:result", side: "right", label: "result", kind: "data", dataType: "unknown" },
    ],
  };
}

export function computeReducePins(): ComputedPins {
  return {
    inputs: [
      EXEC_IN,
      { id: "in:array", side: "left", label: "array", kind: "data", dataType: "array" },
    ],
    outputs: [
      EXEC_OUT,
      { id: "out:result", side: "right", label: "result", kind: "data", dataType: "unknown" },
    ],
  };
}

// ── Flow control node pins (new) ──────────────────────────────────────

export function computeRetryPins(): ComputedPins {
  return {
    inputs: [EXEC_IN],
    outputs: [
      { id: "exec-body", side: "right", label: "body", kind: "exec" },
      EXEC_OUT,
      { id: "exec-failed", side: "right", label: "failed", kind: "exec" },
      { id: "out:attempts", side: "right", label: "attempts", kind: "data", dataType: "number" },
      { id: "out:succeeded", side: "right", label: "succeeded", kind: "data", dataType: "boolean" },
      { id: "out:error", side: "right", label: "error", kind: "data", dataType: "string" },
    ],
  };
}
