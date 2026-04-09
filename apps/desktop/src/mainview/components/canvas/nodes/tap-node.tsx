/**
 * Tap node — debug pass-through.
 *
 *   in ●─────[ TAP ]─────● out
 *
 * Wire it inline anywhere in the data graph. The value flows through
 * unchanged, but the executor records it and the node body shows the
 * most recently captured value as JSON. Like `tcpdump -i any` for your
 * flow data.
 *
 * Type-transparent: the input pin's color matches the upstream source
 * type (resolved live), and the output pin matches it too (since the
 * value is unchanged).
 *
 * Pure data node — no exec pins, never appears in an exec chain. Tap is
 * resolved lazily when a downstream node queries through it.
 */

import { useMemo } from "react";
import {
  Handle,
  Position,
  useNodes,
  useEdges,
  type NodeProps,
} from "@xyflow/react";
import clsx from "clsx";
import type { DataType } from "@twistedrest/core";
import s from "./node.module.css";
import { getInputPinSourceType } from "../../../lib/schema-resolution";
import { useFlowExec } from "../../../lib/exec-context";

const PIN_CLASS: Record<DataType, string> = {
  string: s.pinString,
  number: s.pinNumber,
  boolean: s.pinBoolean,
  object: s.pinObject,
  array: s.pinArray,
  null: s.pinObject,
  unknown: s.pinObject,
};

export function TapNode({ id, selected }: NodeProps) {
  const nodes = useNodes();
  const edges = useEdges();
  const { results } = useFlowExec();

  // Live source type for pin coloring
  const sourceType = useMemo<DataType>(
    () => getInputPinSourceType(id, "in:value", nodes, edges),
    [id, nodes, edges],
  );

  // The executor records every value that passes through (across all
  // parallel iterations) into `_log`. For backward compat we also fall
  // back to the single `value` field.
  const log = (results[id]?._log as unknown[] | undefined) ?? undefined;
  const captured = results[id]?.value;
  const hasLog = log !== undefined && log.length > 0;
  const isMulti = hasLog && log!.length > 1;

  const pinClass = PIN_CLASS[sourceType] ?? s.pinObject;

  return (
    <div className={clsx(s.node, s.tapNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerTap}`}>
        <span className={s.tapBadge}>TAP</span>
        <span className={s.headerTitle}>
          {sourceType === "unknown" ? "passthrough" : `${sourceType} passthrough`}
        </span>
      </div>

      <div className={s.body}>
        {isMulti && (
          <div className={s.tapCount}>
            {log!.length} values captured
          </div>
        )}
        <pre className={s.tapValue}>
          {hasLog
            ? log!.map((v, i) => `${isMulti ? `[${i}] ` : ""}${formatValue(v)}`).join("\n")
            : captured === undefined
              ? "(no value yet — run the flow)"
              : formatValue(captured)}
        </pre>
      </div>

      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle
            id="in:value"
            type="target"
            position={Position.Left}
            className={`${s.pin} ${pinClass}`}
          />
          <span className={s.pinName}>in</span>
        </div>
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>out</span>
          <Handle
            id="out:value"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${pinClass}`}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Compact JSON for the node body. Truncates long values so the node
 * doesn't grow unboundedly. Full value is still in the inspector.
 */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return value.length > 80 ? `"${value.slice(0, 77)}…"` : `"${value}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value, null, 2);
    if (!json) return String(value);
    return json.length > 240 ? `${json.slice(0, 237)}…` : json;
  } catch {
    return String(value);
  }
}
