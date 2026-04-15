/**
 * Set Variable node — exec node that writes a named runtime variable.
 * Similar visually to the old EnvSetter but for flow-scoped variables.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { useFlowExec } from "../../../lib/exec-context";

export function SetVariableNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as { varName?: string; value?: string; valueType?: string };
  const varName = d.varName ?? "";
  const literalValue = d.value ?? "";
  const valueType = d.valueType ?? "string";

  const { statuses } = useFlowExec();
  const status = statuses[id] ?? "idle";
  const statusClass =
    status === "running" ? s.statusRunning
    : status === "ok" ? s.statusOk
    : status === "error" ? s.statusError
    : status === "pending" ? s.statusPending
    : "";

  const subtitle = literalValue
    ? `= ${literalValue} (${valueType})`
    : "wire in:value or set in inspector";

  return (
    <div className={clsx(s.node, s.envSetterNode, selected && s.nodeSelected, statusClass)}>
      <div className={`${s.header} ${s.headerEnvSetter}`}>
        <span className={s.envBadge}>SET</span>
        <span className={s.headerTitle}>{varName || "variable"}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>{subtitle}</span>
        </div>
      </div>

      {/* Exec pins */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle id="exec-in" type="target" position={Position.Left} className={`${s.pin} ${s.pinExec}`} />
          <span className={s.pinName}>exec</span>
        </div>
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>exec</span>
          <Handle id="exec-out" type="source" position={Position.Right} className={`${s.pin} ${s.pinExec}`} />
        </div>
      </div>

      {/* Value input — still available for dynamic wiring */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle id="in:value" type="target" position={Position.Left} className={`${s.pin} ${s.pinUnknown}`} />
          <span className={s.pinName}>value</span>
        </div>
        <span className={s.pinSpacer} />
      </div>
    </div>
  );
}
