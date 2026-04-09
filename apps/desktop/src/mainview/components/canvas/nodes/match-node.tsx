/**
 * Match node — switch/case routing.
 *
 *   exec ──► [ MATCH ]
 *   value ──►          ──► "admin"   (exec)
 *                      ──► "user"    (exec)
 *                      ──► "guest"   (exec)
 *                      ──► default   (exec)
 *
 * Takes a value input, compares it against configured cases (string
 * equality), and fires the matching case's exec output. If no case
 * matches, fires the "default" output.
 *
 * UE Blueprint analogue: Switch on String / Switch on Enum.
 *
 * After the matched branch completes, the Match node is DONE — there's
 * no "continue after switch" exec-out. If you want convergence, wire
 * each case's chain end to the same downstream node.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { useFlowExec } from "../../../lib/exec-context";

export interface MatchCase {
  value: string;
  label?: string;
}

export interface MatchNodeData {
  cases?: MatchCase[];
}

export function MatchNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as MatchNodeData;
  const cases = d.cases ?? [];

  const { statuses } = useFlowExec();
  const status = statuses[id] ?? "idle";
  const statusClass =
    status === "running" ? s.statusRunning
    : status === "ok" ? s.statusOk
    : status === "error" ? s.statusError
    : status === "pending" ? s.statusPending
    : "";

  return (
    <div className={clsx(s.node, s.matchNode, selected && s.nodeSelected, statusClass)}>
      <div className={`${s.header} ${s.headerMatch}`}>
        <span className={s.matchBadge}>MATCH</span>
        <span className={s.headerTitle}>
          {cases.length === 0 ? "no cases" : `${cases.length} case${cases.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* exec-in + value input */}
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
        {cases.length > 0 && (
          <div className={s.pinLabelRight}>
            <span className={s.pinName}>{cases[0]!.label || cases[0]!.value || "case 0"}</span>
            <Handle
              id="exec-case:0"
              type="source"
              position={Position.Right}
              className={`${s.pin} ${s.pinExec}`}
            />
          </div>
        )}
      </div>

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
        {cases.length > 1 && (
          <div className={s.pinLabelRight}>
            <span className={s.pinName}>{cases[1]!.label || cases[1]!.value || "case 1"}</span>
            <Handle
              id="exec-case:1"
              type="source"
              position={Position.Right}
              className={`${s.pin} ${s.pinExec}`}
            />
          </div>
        )}
      </div>

      {/* Remaining case outputs (from index 2+) */}
      {cases.slice(2).map((c, i) => (
        <div className={s.pinRow} key={i + 2}>
          <span className={s.pinSpacer} />
          <div className={s.pinLabelRight}>
            <span className={s.pinName}>{c.label || c.value || `case ${i + 2}`}</span>
            <Handle
              id={`exec-case:${i + 2}`}
              type="source"
              position={Position.Right}
              className={`${s.pin} ${s.pinExec}`}
            />
          </div>
        </div>
      ))}

      {/* Default case — always present */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>default</span>
          <Handle
            id="exec-default"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinExec}`}
          />
        </div>
      </div>
    </div>
  );
}
