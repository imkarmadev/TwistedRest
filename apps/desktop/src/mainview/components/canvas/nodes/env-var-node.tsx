/**
 * EnvVar node — UE-Blueprint-style "Get Variable" node.
 *
 * Holds a reference to a single environment variable key. At run time the
 * executor reads the active environment's value for that key and writes
 * it to this node's output pin (`out:value`). Downstream HTTP nodes
 * consume it via a regular data edge.
 *
 * Validation: at design time the node validates its `varKey` against the
 * environment currently selected on the Start node. If the key isn't in
 * that env's vars, the node turns red and shows a helper message telling
 * the user to add it. This catches "I switched to prod and forgot to set
 * the API_KEY" before they even hit Run.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { useFlowExec } from "../../../lib/exec-context";

export interface EnvVarNodeData {
  varKey?: string;
}

type EnvVarStatus =
  | "unset" // varKey not picked yet
  | "noenv" // no env selected on Start node
  | "missing" // varKey isn't defined in the active env
  | "ok"; // resolves cleanly

export function EnvVarNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as EnvVarNodeData;
  const varKey = d.varKey ?? "";

  const { activeEnvironment } = useFlowExec();

  let status: EnvVarStatus;
  let preview: string | null = null;

  if (!varKey) {
    status = "unset";
  } else if (!activeEnvironment) {
    status = "noenv";
  } else {
    const found = activeEnvironment.vars.find((v) => v.key === varKey);
    if (!found) {
      status = "missing";
    } else {
      status = "ok";
      preview = found.value;
    }
  }

  const isError = status === "missing";

  return (
    <div
      className={clsx(
        s.node,
        s.envVarNode,
        selected && s.nodeSelected,
        isError && s.statusError,
      )}
    >
      <div className={`${s.header} ${s.headerEnvVar}`}>
        <span className={s.envBadge}>ENV</span>
        <span className={s.headerTitle}>{varKey || "select variable"}</span>
      </div>

      <div className={s.body}>
        {status === "ok" && (
          <div className={s.urlText} title={preview ?? ""}>
            <span className={s.envValuePreview}>{preview}</span>
          </div>
        )}
        {status === "unset" && (
          <div className={s.urlText}>
            <span className={s.muted}>pick a variable in the inspector</span>
          </div>
        )}
        {status === "noenv" && (
          <div className={s.urlText}>
            <span className={s.muted}>no environment selected on Start node</span>
          </div>
        )}
        {status === "missing" && (
          <div className={s.envMissing}>
            Not in <strong>"{activeEnvironment?.name}"</strong> — add it in
            settings or pick another env.
          </div>
        )}
      </div>

      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          {varKey || "value"}
          <Handle
            id="out:value"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinString}`}
          />
        </div>
      </div>
    </div>
  );
}
