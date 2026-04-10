/**
 * Emit Event node — broadcasts a named event with a typed payload.
 *
 * Wiring model:
 *   exec-in   ──► Emit Event "userLoaded"  ──► exec-out
 *                  ▲ id (number)
 *                  ▲ name (string)
 *
 * When the executor reaches an Emit Event node:
 *   1. Reads each payload input pin from upstream
 *   2. Finds every On Event node whose name matches
 *   3. Spawns each listener's exec-out chain in parallel (fire-and-forget)
 *   4. Continues immediately past its own exec-out
 *
 * The emitter does NOT wait for listeners. Listeners run on background
 * branches that runFlow awaits at the very end of the run, so the user's
 * Run button becomes idle only after every triggered branch finishes.
 *
 * Payload pins are configured in the inspector — add named typed fields
 * and they appear as input pins on the left.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import {
  computeEmitEventPins,
  type PayloadField,
} from "../../../lib/node-pins";

export interface EmitEventNodeData {
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

export function EmitEventNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as EmitEventNodeData;
  const name = d.name ?? "";
  const payload = d.payload ?? [];
  const pins = computeEmitEventPins(payload);

  return (
    <div className={clsx(s.node, s.eventNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerEmitEvent}`}>
        <span className={s.emitBadge}>EMIT</span>
        <span className={s.headerTitle}>{name || "(unnamed event)"}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>
            {payload.length === 0
              ? "no payload"
              : `${payload.length} field${payload.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      {/* Row: exec-in / exec-out */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle
            id="exec-in"
            type="target"
            position={Position.Left}
            className={`${s.pin} ${s.pinExec}`}
          />
          <span className={s.pinName}>exec</span>
        </div>
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

      {/* Payload input pins */}
      {payload.map((field) => (
        <div className={s.pinRow} key={field.key}>
          <div className={s.pinLabelLeft}>
            <Handle
              id={`in:${field.key}`}
              type="target"
              position={Position.Left}
              className={`${s.pin} ${DATA_PIN_CLASS[field.type] ?? s.pinObject}`}
            />
            <span className={s.pinName}>{field.key || "(unnamed)"}</span>
          </div>
          <span className={s.pinSpacer} />
        </div>
      ))}

      {/* Reference output of computeEmitEventPins so the linter knows
          we're using the helper consistently with collectPinIds */}
      {pins.outputs.length === 0 && null}
    </div>
  );
}
