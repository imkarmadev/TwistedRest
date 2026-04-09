/**
 * Start node — entry point of a flow.
 *
 * Blueprint analogue: Event BeginPlay. Has no input pins. One white exec
 * output pin. Renders:
 *   - An environment dropdown (selects which env vars seed the run)
 *   - A Run button that triggers the executor via FlowExecContext
 */

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import s from "./node.module.css";
import { useFlowExec } from "../../../lib/exec-context";

export function StartNode({ id, data }: NodeProps) {
  const { run, stop, running, environments, canRun, runDisabledReason } = useFlowExec();
  const { setNodes } = useReactFlow();
  const environmentId = (data as { environmentId?: string } | undefined)?.environmentId ?? "";

  const disabled = running || !canRun;
  const buttonLabel = running ? "Running…" : !canRun ? "Cannot run" : "Run Flow";

  const setEnvironment = (envId: string) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...(n.data ?? {}), environmentId: envId || null } }
          : n,
      ),
    );
  };

  return (
    <div className={`${s.node} ${s.startNode}`}>
      <div className={`${s.header} ${s.headerStart}`}>
        <span className={s.headerIcon}>▶</span>
        <span className={s.headerTitle}>Start</span>
      </div>

      <div className={s.body}>
        <label className={s.fieldLabel}>Environment</label>
        {/* `nodrag` is React Flow's built-in opt-out so the select doesn't
            trigger node dragging on mousedown — without it the node sticks
            to the cursor as soon as you open the dropdown. */}
        <select
          className={`${s.envSelect} nodrag`}
          value={environmentId}
          onChange={(e) => setEnvironment(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">— none —</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>

        {running ? (
          <button
            className={`${s.stopBtn} nodrag`}
            onClick={(e) => {
              e.stopPropagation();
              stop();
            }}
          >
            Stop
          </button>
        ) : (
          <button
            className={`${s.runBtn} nodrag`}
            disabled={disabled}
            title={!canRun ? runDisabledReason ?? "" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              run();
            }}
          >
            {buttonLabel}
          </button>
        )}
        {!canRun && !running && runDisabledReason && (
          <div className={s.runReason} title={runDisabledReason}>
            {runDisabledReason}
          </div>
        )}
      </div>

      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          exec
          <Handle
            id="exec-out"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinExec}`}
          />
        </div>
      </div>
    </div>
  );
}
