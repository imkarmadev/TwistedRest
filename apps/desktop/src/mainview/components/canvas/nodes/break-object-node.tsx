/**
 * Break-Object node — UE Blueprint "Break Struct" analogue.
 *
 * Takes one object input and re-emits each top-level field as a separate
 * output pin. Lets you drill into nested API responses without flattening.
 *
 * Pin generation is dynamic: the node looks up its incoming data edge,
 * walks back to the source node, reads its responseSchema (if it's an
 * HTTP node) or its varKey (if it's an env var), and figures out which
 * sub-fields to expose. The whole pin set rebuilds whenever the source
 * schema changes.
 *
 * Disconnect the input → the node falls back to "(connect an object)".
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
import { pinsFromSchema, type DataType } from "@twistedrest/core";
import s from "./node.module.css";
import { resolveSourcePinSchema } from "../../../lib/schema-resolution";

const DATA_PIN_CLASS: Record<string, string> = {
  string: s.pinString,
  number: s.pinNumber,
  boolean: s.pinBoolean,
  object: s.pinObject,
  array: s.pinArray,
  unknown: s.pinObject,
  null: s.pinObject,
};

interface SubPin {
  id: string;
  label: string;
  dataType: DataType;
}

export function BreakObjectNode({ id, selected }: NodeProps) {
  // useNodes/useEdges are REACTIVE — they subscribe to React Flow's store
  // and re-render this component whenever any node or edge changes. The
  // imperative getNodes()/getEdges() do NOT trigger re-renders, which is
  // why an earlier version of this component never updated its pins after
  // a connection was made.
  const nodes = useNodes();
  const edges = useEdges();

  const subPins = useMemo<SubPin[]>(() => {
    const inEdge = edges.find(
      (e) => e.target === id && e.targetHandle === "in:object",
    );
    if (!inEdge) return [];

    const sourceNode = nodes.find((n) => n.id === inEdge.source);
    if (!sourceNode) return [];

    const sourcePinId = (inEdge.sourceHandle ?? "").replace(/^out:/, "");
    const subSchema = resolveSourcePinSchema(sourceNode, sourcePinId, nodes, edges);
    if (!subSchema) return [];

    const descriptors = pinsFromSchema(subSchema);
    return descriptors.map((d) => ({
      id: `out:${d.id}`,
      label: d.label,
      dataType: d.dataType ?? "unknown",
    }));
  }, [id, nodes, edges]);

  return (
    <div className={clsx(s.node, s.breakObjectNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerBreakObject}`}>
        <span className={s.breakBadge}>BREAK</span>
        <span className={s.headerTitle}>Object</span>
      </div>

      <div className={s.body}>
        {subPins.length === 0 ? (
          <div className={s.urlText}>
            <span className={s.muted}>connect an object</span>
          </div>
        ) : (
          <div className={s.urlText}>
            <span className={s.muted}>
              {subPins.length} field{subPins.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>

      {/* Single input pin (object) on the left */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle
            id="in:object"
            type="target"
            position={Position.Left}
            className={`${s.pin} ${s.pinObject}`}
          />
          <span className={s.pinName}>object</span>
        </div>
        <span className={s.pinSpacer} />
      </div>

      {/* Output pins, one per field of the source object schema */}
      {subPins.map((pin) => (
        <div className={s.pinRow} key={pin.id}>
          <span className={s.pinSpacer} />
          <div className={s.pinLabelRight}>
            <span className={s.pinName}>{pin.label}</span>
            <Handle
              id={pin.id}
              type="source"
              position={Position.Right}
              className={`${s.pin} ${DATA_PIN_CLASS[pin.dataType] ?? s.pinObject}`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// resolveSourcePinSchema lives in lib/schema-resolution.ts so the Convert
// node can share the same walker. Don't duplicate it here.
