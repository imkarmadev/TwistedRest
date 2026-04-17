/**
 * Get Variable node — data node that reads a named runtime variable.
 * Shows red at runtime if the variable was never set by a Set Variable node.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { useFlowExec } from "../../../lib/exec-context";
import { useFlowVariables } from "../../../lib/variables-context";
import { pinClass } from "../../../lib/pin-classes";

export function GetVariableNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as { varName?: string };
  const varName = d.varName ?? "";

  const { variables } = useFlowVariables();
  const decl = variables.find((v) => v.name === varName);
  const declaredType = decl?.type ?? "unknown";

  const { statuses } = useFlowExec();
  const status = statuses[id] ?? "idle";
  const statusClass =
    status === "running" ? s.statusRunning
    : status === "ok" ? s.statusOk
    : status === "error" ? s.statusError
    : status === "pending" ? s.statusPending
    : "";

  return (
    <div className={clsx(s.node, s.envVarNode, selected && s.nodeSelected, statusClass)}>
      <div className={`${s.header} ${s.headerEnvVar}`}>
        <span className={s.envBadge}>VAR</span>
        <span className={s.headerTitle}>{varName || "variable"}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>
            {varName ? `reads ${varName}` : "pick a name in the inspector"}
          </span>
        </div>
      </div>

      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          {varName || "value"}
          <Handle
            id="out:value"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${pinClass(s, declaredType)}`}
          />
        </div>
      </div>
    </div>
  );
}
