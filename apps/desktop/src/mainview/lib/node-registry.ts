/**
 * Node registry — the single source of truth for every node type the
 * canvas can spawn. Used by:
 *
 *   - The toolbar buttons (label + factory)
 *   - The searchable palette (label + category + description + pin flags)
 *   - The drag-pin-into-empty-canvas spawner (compatibility filter via
 *     pin flags + a default-target-pin hint for auto-wiring)
 *
 * Add a new node type? Add it here and the palette + toolbar pick it up
 * automatically.
 */

import type { ComponentType } from "react";
import type { NodeProps } from "@xyflow/react";
import type { DataType } from "@twistedflow/core";

import { StartNode } from "../components/canvas/nodes/start-node";
import { HttpRequestNode } from "../components/canvas/nodes/http-request-node";
import { EnvVarNode } from "../components/canvas/nodes/env-var-node";
import { BreakObjectNode } from "../components/canvas/nodes/break-object-node";
import {
  ForEachSequentialNode,
  ForEachParallelNode,
} from "../components/canvas/nodes/for-each-node";
import { ConvertNode } from "../components/canvas/nodes/convert-node";
import { EmitEventNode } from "../components/canvas/nodes/emit-event-node";
import { OnEventNode } from "../components/canvas/nodes/on-event-node";
import { TapNode } from "../components/canvas/nodes/tap-node";
import { LogNode } from "../components/canvas/nodes/log-node";
import { MakeObjectNode } from "../components/canvas/nodes/make-object-node";
import { FunctionNode } from "../components/canvas/nodes/function-node";
import { SetVariableNode } from "../components/canvas/nodes/set-variable-node";
import { GetVariableNode } from "../components/canvas/nodes/get-variable-node";
import { MatchNode } from "../components/canvas/nodes/match-node";
import { SystemNode } from "../components/canvas/nodes/system-node";

export type NodeCategory =
  | "Flow Control"
  | "HTTP"
  | "Variables"
  | "Data"
  | "Events";

export interface NodeTypeDef {
  /** Internal type id, persisted to SQLite as `kind`. */
  type: string;
  /** Human-readable name for the palette and toolbar. */
  label: string;
  /** Category bucket for grouping in the palette. */
  category: NodeCategory;
  /** One-line description shown under the label in the palette. */
  description: string;
  /** React component that renders the node on the canvas. */
  component: ComponentType<NodeProps>;

  /** Pin presence flags — drives the drag-pin-into-empty-canvas filter. */
  hasExecIn: boolean;
  hasExecOut: boolean;
  hasDataIn: boolean;
  hasDataOut: boolean;

  /**
   * Default target pin id when auto-wiring after a drag-and-drop spawn.
   * For exec drops we wire to `exec-in`; for data drops we wire to the
   * first input pin matching the source's type, or whatever this hint
   * names.
   */
  defaultExecInPin?: string;
  defaultDataInPin?: string;

  /**
   * Filter applied by the drag-pin-into-empty-canvas spawner. Given the
   * type of the dragged source pin, returns true if this node has any
   * input pin that can accept it. Defaults to "accept anything" for nodes
   * with `hasDataIn: true` if not specified — the strict filtering only
   * matters for nodes with strongly-typed inputs (BreakObject = object,
   * ForEach = array, etc.).
   */
  acceptsDataInput?: (sourceType: DataType) => boolean;

  /** Factory returning the initial node data for newly-spawned instances. */
  defaultData: () => Record<string, unknown>;

  /**
   * If true, this node type is "singleton-ish" — only one per flow makes
   * sense (e.g. Start). The palette filters it out when one already exists.
   */
  singleton?: boolean;
}

export const NODE_REGISTRY: NodeTypeDef[] = [
  {
    type: "start",
    label: "Start",
    category: "Flow Control",
    description: "Entry point of the flow. Holds the active environment selector + Run button.",
    component: StartNode,
    hasExecIn: false,
    hasExecOut: true,
    hasDataIn: false,
    hasDataOut: false,
    defaultData: () => ({ environmentFilename: null }),
    singleton: true,
  },
  {
    type: "httpRequest",
    label: "HTTP Request",
    category: "HTTP",
    description: "Fires an HTTP call. Templates resolve from upstream pins; response validated against a Zod schema.",
    component: HttpRequestNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: true,
    defaultExecInPin: "exec-in",
    // Inputs are template tokens; they get stringified, so accept anything.
    // Note: there's no statically-known default data pin (template tokens
    // generate them at runtime), so we leave defaultDataInPin unset and
    // the auto-wire just won't fire for HttpRequest data drops.
    acceptsDataInput: () => true,
    defaultData: () => ({
      method: "GET",
      url: "/users",
      headers: [],
      body: "",
      responseSchema: "z.object({\n  id: z.string(),\n  name: z.string(),\n})",
    }),
  },
  {
    type: "envVar",
    label: "Env Var",
    category: "Variables",
    description: "Reads a value from the active environment. Wire its output into a node's input pin.",
    component: EnvVarNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: false,
    hasDataOut: true,
    defaultData: () => ({ varKey: "" }),
  },
  {
    type: "setVariable",
    label: "Set Variable",
    category: "Variables",
    description: "Set a runtime variable within the flow. Read it with Get Variable.",
    component: SetVariableNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:value",
    acceptsDataInput: () => true,
    defaultData: () => ({ varName: "" }),
  },
  {
    type: "getVariable",
    label: "Get Variable",
    category: "Variables",
    description: "Read a runtime variable set by Set Variable. Red if never set.",
    component: GetVariableNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: false,
    hasDataOut: true,
    defaultData: () => ({ varName: "" }),
  },
  {
    type: "breakObject",
    label: "Break Object",
    category: "Data",
    description: "Splits an object pin into one output pin per top-level field. Drill into nested responses.",
    component: BreakObjectNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: true,
    defaultDataInPin: "in:object",
    // Only meaningful for objects. Allow "unknown" too since the user
    // might be wiring from a not-yet-introspected source.
    acceptsDataInput: (t) => t === "object" || t === "unknown",
    defaultData: () => ({}),
  },
  {
    type: "convert",
    label: "Convert",
    category: "Data",
    description: "Coerces a value between types (string ↔ number ↔ boolean ↔ JSON).",
    component: ConvertNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: true,
    defaultDataInPin: "in:value",
    // Convert is universal — that's the point.
    acceptsDataInput: () => true,
    defaultData: () => ({ targetType: "string" }),
  },
  {
    type: "tap",
    label: "Tap",
    category: "Data",
    description: "Pass-through debug probe. Shows the value flowing through it. Use anywhere you want to inspect data live.",
    component: TapNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: true,
    defaultDataInPin: "in:value",
    // Tap is type-transparent — accepts everything.
    acceptsDataInput: () => true,
    defaultData: () => ({}),
  },
  {
    type: "log",
    label: "Log",
    category: "Data",
    description: "Exec-chain print sink. Writes the value to the bottom Console panel when reached.",
    component: LogNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:value",
    acceptsDataInput: () => true,
    defaultData: () => ({ label: "Log" }),
  },
  {
    type: "function",
    label: "Function",
    category: "Data",
    description: "Custom TypeScript transform. Write code that receives typed inputs and returns typed outputs.",
    component: FunctionNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: true,
    acceptsDataInput: () => true,
    defaultData: () => ({
      name: "transform",
      inputs: [{ key: "value", type: "unknown" as DataType }],
      outputs: [{ key: "result", type: "string" as DataType }],
      code: 'return {\n  result: String(inputs.value),\n}',
    }),
  },
  {
    type: "makeObject",
    label: "Make Object",
    category: "Data",
    description: "Build an object from named typed fields. Inverse of Break Object — wire pins in, get one object out.",
    component: MakeObjectNode,
    hasExecIn: false,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: true,
    // Field input pins are dynamic — added by the user. Accept anything.
    acceptsDataInput: () => true,
    defaultData: () => ({ fields: [] }),
  },
  {
    type: "forEachSequential",
    label: "ForEach (sequential)",
    category: "Flow Control",
    description: "Iterates an array, runs the body chain once per item in order.",
    component: ForEachSequentialNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: true,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:array",
    acceptsDataInput: (t) => t === "array" || t === "unknown",
    defaultData: () => ({}),
  },
  {
    type: "forEachParallel",
    label: "ForEach (parallel)",
    category: "Flow Control",
    description: "Iterates an array, runs the body chain for all items concurrently.",
    component: ForEachParallelNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: true,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:array",
    acceptsDataInput: (t) => t === "array" || t === "unknown",
    defaultData: () => ({}),
  },
  {
    type: "match",
    label: "Match",
    category: "Flow Control",
    description: "Switch/case routing. Compares a value against configured cases and fires the matching branch.",
    component: MatchNode,
    hasExecIn: true,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:value",
    acceptsDataInput: () => true,
    defaultData: () => ({
      cases: [
        { value: "true", label: "true" },
        { value: "false", label: "false" },
      ],
    }),
  },
  {
    type: "emitEvent",
    label: "Emit Event",
    category: "Events",
    description: "Broadcasts a named event with a typed payload. Listeners with the same name fire in parallel.",
    component: EmitEventNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    // Payload pins are dynamic — accept anything since the user picks types
    acceptsDataInput: () => true,
    defaultData: () => ({ name: "myEvent", payload: [] }),
  },
  {
    type: "onEvent",
    label: "On Event",
    category: "Events",
    description: "Listens for a named event. Output pins mirror the matching Emit Event's payload.",
    component: OnEventNode,
    hasExecIn: false,
    hasExecOut: true,
    hasDataIn: false,
    hasDataOut: true,
    defaultData: () => ({ name: "myEvent" }),
  },
  // ── System nodes ────────────────────────────────────────────────
  {
    type: "print",
    label: "Print",
    category: "System" as NodeCategory,
    description: "Print a value to stdout. In the desktop app, also shows in the console panel.",
    component: SystemNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:value",
    acceptsDataInput: () => true,
    defaultData: () => ({}),
  },
  {
    type: "shellExec",
    label: "Shell Exec",
    category: "System" as NodeCategory,
    description: "Run a shell command. Captures stdout, stderr, exit code.",
    component: SystemNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: true,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:stdin",
    acceptsDataInput: () => true,
    defaultData: () => ({ command: "echo hello", failOnError: false }),
  },
  {
    type: "fileRead",
    label: "File Read",
    category: "System" as NodeCategory,
    description: "Read a file from disk. Parses JSON automatically.",
    component: SystemNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: false,
    hasDataOut: true,
    defaultExecInPin: "exec-in",
    defaultData: () => ({ path: "" }),
  },
  {
    type: "fileWrite",
    label: "File Write",
    category: "System" as NodeCategory,
    description: "Write content to a file. Creates parent directories.",
    component: SystemNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: true,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:content",
    acceptsDataInput: () => true,
    defaultData: () => ({ path: "" }),
  },
  {
    type: "sleep",
    label: "Sleep",
    category: "System" as NodeCategory,
    description: "Pause execution for a duration in milliseconds.",
    component: SystemNode,
    hasExecIn: true,
    hasExecOut: true,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:ms",
    acceptsDataInput: (t) => t === "number" || t === "unknown",
    defaultData: () => ({ ms: 1000 }),
  },
  {
    type: "exit",
    label: "Exit",
    category: "System" as NodeCategory,
    description: "Terminate the flow. Non-zero code = error (CLI exits with that code).",
    component: SystemNode,
    hasExecIn: true,
    hasExecOut: false,
    hasDataIn: true,
    hasDataOut: false,
    defaultExecInPin: "exec-in",
    defaultDataInPin: "in:code",
    acceptsDataInput: (t) => t === "number" || t === "unknown",
    defaultData: () => ({ message: "" }),
  },
];

/** Lookup helper. */
export function findNodeDef(type: string): NodeTypeDef | undefined {
  return NODE_REGISTRY.find((n) => n.type === type);
}

/** Map of type → component, ready to pass to React Flow's `nodeTypes` prop. */
export const NODE_TYPES_MAP: Record<string, ComponentType<NodeProps>> =
  Object.fromEntries(NODE_REGISTRY.map((d) => [d.type, d.component]));

/** All categories that have at least one node, in registry order. */
export function listCategories(): NodeCategory[] {
  const seen = new Set<NodeCategory>();
  const ordered: NodeCategory[] = [];
  for (const def of NODE_REGISTRY) {
    if (!seen.has(def.category)) {
      seen.add(def.category);
      ordered.push(def.category);
    }
  }
  return ordered;
}
