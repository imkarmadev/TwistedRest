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

import { inputPinsFor, pinsFromSchema, type DataType } from "@twistedrest/core";
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

  // `status` is always present — the HTTP response code (200, 404, etc.)
  const statusPin: ComputedPin = {
    id: "out:status",
    side: "right",
    label: "status",
    kind: "data",
    dataType: "number",
  };

  return {
    inputs: [EXEC_IN, ...inputDataPins],
    outputs: [EXEC_OUT, statusPin, ...outputDataPins],
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
