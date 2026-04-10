/**
 * On Event node — listens for a named event, fires its exec-out branch
 * when any matching Emit Event runs.
 *
 *                   On Event "userLoaded" ──► exec-out
 *                                              id (number)
 *                                              name (string)
 *
 * Has NO exec input — listeners are triggered exclusively by Emit Event
 * nodes with the same name. Output pins are auto-mirrored from the
 * matching Emit Event's payload declaration: the emitter is the single
 * source of truth for the payload shape, the listener just reads it.
 *
 * If no matching emitter exists, the listener has no payload pins (just
 * the exec-out).
 */

import { useMemo } from "react";
import {
  Handle,
  Position,
  useNodes,
  type NodeProps,
} from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import type { PayloadField } from "../../../lib/node-pins";

export interface OnEventNodeData {
  name?: string;
}

interface EmitEventDataLite {
  name?: string;
  payload?: PayloadField[];
}

const DATA_PIN_CLASS: Record<string, string> = {
  string: s.pinString,
  number: s.pinNumber,
  boolean: s.pinBoolean,
  object: s.pinObject,
  array: s.pinArray,
  unknown: s.pinObject,
  null: s.pinObject,
};

export function OnEventNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as OnEventNodeData;
  const name = d.name ?? "";

  // useNodes() is REACTIVE — re-renders when any node's data changes,
  // so we pick up payload edits on a matching emitter immediately.
  const nodes = useNodes();

  // Find every matching emitter and take the union of their payload
  // fields. With multiple emitters using the same name, fields from
  // later emitters override earlier ones if keys collide.
  const payload = useMemo<PayloadField[]>(() => {
    if (!name) return [];
    const merged = new Map<string, PayloadField>();
    for (const n of nodes) {
      if (n.type !== "emitEvent") continue;
      const ed = (n.data ?? {}) as EmitEventDataLite;
      if (ed.name !== name) continue;
      for (const f of ed.payload ?? []) {
        merged.set(f.key, f);
      }
    }
    return [...merged.values()];
  }, [name, nodes]);

  return (
    <div className={clsx(s.node, s.eventNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerOnEvent}`}>
        <span className={s.onBadge}>ON</span>
        <span className={s.headerTitle}>{name || "(unnamed event)"}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          {!name ? (
            <span className={s.muted}>set a name in the inspector</span>
          ) : payload.length === 0 ? (
            <span className={s.muted}>no matching Emit Event yet</span>
          ) : (
            <span className={s.muted}>
              {payload.length} field{payload.length === 1 ? "" : "s"} mirrored
            </span>
          )}
        </div>
      </div>

      {/* exec-out only — no input */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>exec</span>
          <Handle
            id="exec-out"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinExec}`}
          />
        </div>
      </div>

      {/* Mirrored payload outputs */}
      {payload.map((field) => (
        <div className={s.pinRow} key={field.key}>
          <span className={s.pinSpacer} />
          <div className={s.pinLabelRight}>
            <span className={s.pinName}>{field.key || "(unnamed)"}</span>
            <Handle
              id={`out:${field.key}`}
              type="source"
              position={Position.Right}
              className={`${s.pin} ${DATA_PIN_CLASS[field.type] ?? s.pinObject}`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
