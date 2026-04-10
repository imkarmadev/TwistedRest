/**
 * Convert node — type coercion between pins.
 *
 * Single input, single output, configurable target type via the inspector.
 *
 * Common use case: an HTTP node returns `id: number`, but the next HTTP
 * node's URL template needs it as a string for path interpolation. Drop
 * a Convert node, set target = string, wire it in. Same for string →
 * number when an API returns "1" but the next request expects 1.
 *
 * Pure data node — no exec pins. The executor resolves it lazily via
 * resolvePinValue when a downstream HTTP node looks up its inputs.
 */

import { useMemo } from "react";
import { Handle, Position, useNodes, useEdges, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import type { DataType } from "@twistedflow/core";
import s from "./node.module.css";
import { getInputPinSourceType } from "../../../lib/schema-resolution";

export type ConvertTargetType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "json";

export interface ConvertNodeData {
  targetType?: ConvertTargetType;
}

const TARGET_LABEL: Record<ConvertTargetType, string> = {
  string: "→ string",
  number: "→ number",
  integer: "→ integer",
  boolean: "→ boolean",
  json: "→ JSON text",
};

const TARGET_PIN_CLASS: Record<ConvertTargetType, string> = {
  string: "pinString",
  number: "pinNumber",
  integer: "pinNumber",
  boolean: "pinBoolean",
  json: "pinString",
};

const SOURCE_PIN_CLASS: Record<DataType, string> = {
  string: "pinString",
  number: "pinNumber",
  boolean: "pinBoolean",
  object: "pinObject",
  array: "pinArray",
  null: "pinObject",
  unknown: "pinObject",
};

export function ConvertNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as ConvertNodeData;
  const target = d.targetType ?? "string";

  // Subscribe to graph changes so the source type updates live when the
  // user wires/unwires the input.
  const nodes = useNodes();
  const edges = useEdges();
  const sourceType = useMemo<DataType>(
    () => getInputPinSourceType(id, "in:value", nodes, edges),
    [id, nodes, edges],
  );

  const outPinClass = (s as Record<string, string>)[TARGET_PIN_CLASS[target]] ?? s.pinString;
  const inPinClass = (s as Record<string, string>)[SOURCE_PIN_CLASS[sourceType]] ?? s.pinObject;

  return (
    <div className={clsx(s.node, s.convertNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerConvert}`}>
        <span className={s.convertBadge}>CONVERT</span>
        <span className={s.headerTitle}>{TARGET_LABEL[target]}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>
            {sourceType === "unknown" ? "not connected" : `${sourceType} → ${target}`}
          </span>
        </div>
      </div>

      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle
            id="in:value"
            type="target"
            position={Position.Left}
            className={`${s.pin} ${inPinClass}`}
          />
          <span className={s.pinName}>in</span>
        </div>
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>out</span>
          <Handle
            id="out:value"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${outPinClass}`}
          />
        </div>
      </div>
    </div>
  );
}
