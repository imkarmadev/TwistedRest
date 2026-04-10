/**
 * ForEach node — iterates an array, executing a body sub-chain
 * once per item.
 *
 * Two variants share this component, distinguished by the `mode` prop:
 *
 *   sequential — items processed one at a time, body finishes before next item.
 *                Use when you need ordering or rate-limiting.
 *
 *   parallel   — all items fire simultaneously via Promise.all. Each iteration
 *                gets an isolated outputs cache so they don't race.
 *                Use when items are independent and you want speed.
 *
 * Pin layout:
 *   left  — exec-in (control), in:array (data, purple/array color)
 *   right — exec-body (control, fires per item), exec-out (control, fires after loop done)
 *           out:item (data, current iteration's element)
 *           out:index (data, current iteration's index)
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";

export interface ForEachNodeData {
  // Currently no per-instance config — both variants use the same data shape.
  [key: string]: unknown;
}

interface ForEachNodeProps extends NodeProps {
  mode: "sequential" | "parallel";
}

export function ForEachNode({ selected, mode }: ForEachNodeProps) {
  const headerClass = mode === "parallel" ? s.headerForEachParallel : s.headerForEachSequential;
  const badgeClass = mode === "parallel" ? s.forEachBadgeParallel : s.forEachBadgeSequential;
  const badgeLabel = mode === "parallel" ? "PARALLEL" : "SEQUENTIAL";

  return (
    <div className={clsx(s.node, s.forEachNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${headerClass}`}>
        <span className={badgeClass}>{badgeLabel}</span>
        <span className={s.headerTitle}>For Each</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>
            {mode === "parallel"
              ? "fires all items at once"
              : "one item at a time"}
          </span>
        </div>
      </div>

      {/* Row 1: exec-in / exec-body */}
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
          <span className={s.pinName}>body</span>
          <Handle
            id="exec-body"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinExec}`}
          />
        </div>
      </div>

      {/* Row 2: in:array / exec-out (loop completed) */}
      <div className={s.pinRow}>
        <div className={s.pinLabelLeft}>
          <Handle
            id="in:array"
            type="target"
            position={Position.Left}
            className={`${s.pin} ${s.pinArray}`}
          />
          <span className={s.pinName}>array</span>
        </div>
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>completed</span>
          <Handle
            id="exec-out"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinExec}`}
          />
        </div>
      </div>

      {/* Row 3: spacer / out:item */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>item</span>
          <Handle
            id="out:item"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinObject}`}
          />
        </div>
      </div>

      {/* Row 4: spacer / out:index */}
      <div className={s.pinRow}>
        <span className={s.pinSpacer} />
        <div className={s.pinLabelRight}>
          <span className={s.pinName}>index</span>
          <Handle
            id="out:index"
            type="source"
            position={Position.Right}
            className={`${s.pin} ${s.pinNumber}`}
          />
        </div>
      </div>
    </div>
  );
}

// Two thin wrappers so React Flow can register them as distinct types.
export function ForEachSequentialNode(props: NodeProps) {
  return <ForEachNode {...props} mode="sequential" />;
}

export function ForEachParallelNode(props: NodeProps) {
  return <ForEachNode {...props} mode="parallel" />;
}
