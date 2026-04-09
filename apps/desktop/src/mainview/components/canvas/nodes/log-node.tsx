/**
 * Log node — exec-chain print to the bottom console panel.
 *
 *   exec-in ──► [ LOG "label" ] ──► exec-out
 *               value (any)
 *
 * UE Blueprint analogue: Print String. Wire it inline anywhere in an
 * exec chain. When control flow reaches it, the executor reads the
 * `value` input pin and emits an entry to the console (label + JSON
 * value + timestamp). Then continues to exec-out.
 *
 * Unlike Tap (pure data), Log:
 *   - Has exec pins → it's an explicit sync point in the chain
 *   - Always fires when reached → no lazy / no maybe
 *   - Has a configurable label so you can tell entries apart in the console
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";

export interface LogNodeData {
  label?: string;
}

export function LogNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as LogNodeData;
  const label = d.label ?? "Log";

  return (
    <div className={clsx(s.node, s.logNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerLog}`}>
        <span className={s.logBadge}>LOG</span>
        <span className={s.headerTitle}>{label}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>prints to console panel</span>
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

      {/* Row: value input */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle
            id="in:value"
            type="target"
            position={Position.Left}
            className={`${s.pin} ${s.pinObject}`}
          />
          <span className={s.pinName}>value</span>
        </div>
        <span className={s.pinSpacer} />
      </div>
    </div>
  );
}
