/**
 * If/Else node — boolean branching with exec-true and exec-false outputs.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { useFlowExec } from "../../../lib/exec-context";

export function IfElseNode({ id, selected }: NodeProps) {
  const { statuses } = useFlowExec();
  const status = statuses[id] ?? "idle";
  const statusClass =
    status === "running" ? s.statusRunning
    : status === "ok" ? s.statusOk
    : status === "error" ? s.statusError
    : status === "pending" ? s.statusPending
    : "";

  return (
    <div className={clsx(s.node, selected && s.nodeSelected, statusClass)}>
      <div className={`${s.header} ${s.headerMatch}`}>
        <span className={s.headerTitle}>If / Else</span>
      </div>

      {/* Exec in */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle id="exec-in" type="target" position={Position.Left} className={`${s.pin} ${s.pinExec}`} />
          <span className={s.pinName}>exec</span>
        </div>
        <span className={s.pinSpacer} />
      </div>

      {/* Condition input */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle id="in:condition" type="target" position={Position.Left} className={`${s.pin} ${s.pinBoolean}`} />
          <span className={s.pinName}>condition</span>
        </div>
        <span className={s.pinSpacer} />
      </div>

      {/* True branch */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName} style={{ color: "#4ade80" }}>true</span>
          <Handle id="exec-true" type="source" position={Position.Right} className={`${s.pin} ${s.pinExec}`} />
        </div>
      </div>

      {/* False branch */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName} style={{ color: "#f87171" }}>false</span>
          <Handle id="exec-false" type="source" position={Position.Right} className={`${s.pin} ${s.pinExec}`} />
        </div>
      </div>
    </div>
  );
}
