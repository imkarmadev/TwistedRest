/**
 * Generic system node component — used by Print, Shell Exec, File Read,
 * File Write, Sleep, Exit. Renders exec pins + configured data pins.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { pinClass } from "../../../lib/pin-classes";
import { useFlowExec } from "../../../lib/exec-context";
import type { DataType } from "@twistedflow/core";

interface SystemNodeConfig {
  badge: string;
  label: string;
  subtitle?: string;
  inputs: Array<{ id: string; label: string; type: DataType }>;
  outputs: Array<{ id: string; label: string; type: DataType }>;
}

const NODE_CONFIGS: Record<string, (data: Record<string, unknown>) => SystemNodeConfig> = {
  print: () => ({
    badge: "SYS",
    label: "Print",
    subtitle: "stdout",
    inputs: [{ id: "in:value", label: "value", type: "unknown" }],
    outputs: [],
  }),
  shellExec: (data) => ({
    badge: "SYS",
    label: "Shell Exec",
    subtitle: (data.command as string)?.slice(0, 30) || "command",
    inputs: [{ id: "in:stdin", label: "stdin", type: "string" }],
    outputs: [
      { id: "out:stdout", label: "stdout", type: "string" },
      { id: "out:stderr", label: "stderr", type: "string" },
      { id: "out:exitCode", label: "exitCode", type: "number" },
    ],
  }),
  fileRead: (data) => ({
    badge: "SYS",
    label: "File Read",
    subtitle: (data.path as string)?.slice(0, 30) || "path",
    inputs: [],
    outputs: [
      { id: "out:content", label: "content", type: "string" },
      { id: "out:path", label: "path", type: "string" },
    ],
  }),
  fileWrite: (data) => ({
    badge: "SYS",
    label: "File Write",
    subtitle: (data.path as string)?.slice(0, 30) || "path",
    inputs: [{ id: "in:content", label: "content", type: "unknown" }],
    outputs: [
      { id: "out:path", label: "path", type: "string" },
      { id: "out:bytes", label: "bytes", type: "number" },
    ],
  }),
  sleep: (data) => ({
    badge: "SYS",
    label: "Sleep",
    subtitle: `${data.ms ?? 1000}ms`,
    inputs: [{ id: "in:ms", label: "ms", type: "number" }],
    outputs: [],
  }),
  exit: () => ({
    badge: "SYS",
    label: "Exit",
    subtitle: "exit code",
    inputs: [{ id: "in:code", label: "code", type: "number" }],
    outputs: [],
  }),
};

export function SystemNode({ id, data, selected, type }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  const configFn = NODE_CONFIGS[type ?? ""];
  const config = configFn ? configFn(d) : { badge: "SYS", label: type ?? "System", inputs: [], outputs: [] };

  const { statuses } = useFlowExec();
  const status = statuses[id] ?? "idle";
  const statusClass =
    status === "running" ? s.statusRunning
    : status === "ok" ? s.statusOk
    : status === "error" ? s.statusError
    : status === "pending" ? s.statusPending
    : "";

  return (
    <div className={clsx(s.node, s.customNodeEl, selected && s.nodeSelected, statusClass)}>
      <div className={`${s.header} ${s.headerCustom}`}>
        <span className={s.customBadge}>{config.badge}</span>
        <span className={s.headerTitle}>{config.label}</span>
      </div>

      {config.subtitle && (
        <div className={s.body}>
          <div className={s.urlText}>
            <span className={s.muted}>{config.subtitle}</span>
          </div>
        </div>
      )}

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

      {/* Data pins */}
      {Array.from({ length: Math.max(config.inputs.length, config.outputs.length) }, (_, i) => {
        const inp = config.inputs[i];
        const out = config.outputs[i];
        return (
          <div className={s.pinRow} key={i}>
            {inp ? (
              <div className={s.pinLabelLeft}>
                <Handle id={inp.id} type="target" position={Position.Left} className={`${s.pin} ${pinClass(s, inp.type)}`} />
                <span className={s.pinName}>{inp.label}</span>
              </div>
            ) : <span className={s.pinSpacer} />}
            {out ? (
              <div className={s.pinLabelRight}>
                <span className={s.pinName}>{out.label}</span>
                <Handle id={out.id} type="source" position={Position.Right} className={`${s.pin} ${pinClass(s, out.type)}`} />
              </div>
            ) : <span className={s.pinSpacer} />}
          </div>
        );
      })}
    </div>
  );
}
