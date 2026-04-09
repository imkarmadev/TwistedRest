/**
 * Function node — user-authored TypeScript transform.
 *
 *   firstName (string) ──┐
 *    lastName (string) ──┤─[ FN "formatUser" ]── fullName (string)
 *         age (number) ──┘                       isAdult (boolean)
 *
 * Pure data node (no exec pins). Declared input/output pins are typed
 * and visible on the canvas. The code body receives `inputs` (an object
 * with each declared input field) and must return an object matching the
 * declared outputs.
 *
 * Execution: `new Function('inputs', userCode)(resolvedInputs)` — same
 * sandboxing level as our Zod schema evaluator. Errors surface as a red
 * node status.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { pinClass } from "../../../lib/pin-classes";
import type { PayloadField } from "../../../lib/node-pins";

export interface FunctionNodeData {
  name?: string;
  inputs?: PayloadField[];
  outputs?: PayloadField[];
  code?: string;
}

export function FunctionNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as FunctionNodeData;
  const name = d.name ?? "function";
  const inputs = d.inputs ?? [];
  const outputs = d.outputs ?? [];

  const rowCount = Math.max(inputs.length, outputs.length);
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    left: inputs[i],
    right: outputs[i],
  }));

  return (
    <div className={clsx(s.node, s.functionNode, selected && s.nodeSelected)}>
      <div className={`${s.header} ${s.headerFunction}`}>
        <span className={s.fnBadge}>FN</span>
        <span className={s.headerTitle}>{name}</span>
      </div>

      <div className={s.body}>
        <div className={s.urlText}>
          <span className={s.muted}>
            {inputs.length} in → {outputs.length} out
          </span>
        </div>
      </div>

      {rows.map((row, i) => (
        <div className={s.pinRow} key={i}>
          {row.left ? (
            <div className={s.pinLabelLeft}>
              <Handle
                id={`in:${row.left.key}`}
                type="target"
                position={Position.Left}
                className={`${s.pin} ${pinClass(s, row.left.type)}`}
              />
              <span className={s.pinName}>{row.left.key}</span>
            </div>
          ) : (
            <span className={s.pinSpacer} />
          )}
          {row.right ? (
            <div className={s.pinLabelRight}>
              <span className={s.pinName}>{row.right.key}</span>
              <Handle
                id={`out:${row.right.key}`}
                type="source"
                position={Position.Right}
                className={`${s.pin} ${pinClass(s, row.right.type)}`}
              />
            </div>
          ) : (
            <span className={s.pinSpacer} />
          )}
        </div>
      ))}
    </div>
  );
}
