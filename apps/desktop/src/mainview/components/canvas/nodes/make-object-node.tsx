/**
 * Make Object node — inverse of Break Object.
 *
 *   id    (number) ──┐
 *   name  (string) ──┼─[ MAKE Object ]── object ──►
 *   email (string) ──┘
 *
 * Configure named typed fields in the inspector — each becomes an input pin on the left. The output
 * pin emits a single object containing whatever values you wired in.
 *
 * Common uses:
 *   - Bundle three values into one for a Log node
 *   - Assemble an HTTP request body
 *   - Pass structured data through a single edge
 *
 * Pure data node — no exec pins. Resolved lazily when something
 * downstream queries through it (or via the post-run Tap-style
 * resolution if needed; not needed here since the consumer side
 * handles it).
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import type { PayloadField } from "../../../lib/node-pins";

export interface MakeObjectNodeData {
  fields?: PayloadField[];
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

export function MakeObjectNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as MakeObjectNodeData;
  const fields = d.fields ?? [];

  return (
    <div className={clsx(s.node, s.makeObjectNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerMakeObject}`}>
        <span className={s.makeBadge}>MAKE</span>
        <span className={s.headerTitle}>Object</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>
            {fields.length === 0
              ? "no fields — add some in the inspector"
              : `${fields.length} field${fields.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      {/* Output object pin (single, on the right) */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>object</span>
          <Handle
            id="out:object"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinObject}`}
          />
        </div>
      </div>

      {/* Field input pins (left side, one per declared field) */}
      {fields.map((f) => (
        <div className={s.pinRow} key={f.key}>
          <div className={s.pinLabelLeft}>
            <Handle
              id={`in:${f.key}`}
              type="target"
              position={Position.Left}
              className={`${s.pin} ${DATA_PIN_CLASS[f.type] ?? s.pinObject}`}
            />
            <span className={s.pinName}>{f.key || "(unnamed)"}</span>
          </div>
          <span className={s.pinSpacer} />
        </div>
      ))}
    </div>
  );
}
