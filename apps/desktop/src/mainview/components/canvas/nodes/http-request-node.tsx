/**
 * HttpRequest node — fires an HTTP call.
 *
 * Pin layout is computed live from the node's `data` (see lib/node-pins.ts):
 *   - Input data pins come from `#{name}` tokens parsed out of url/headers/body
 *   - Output data pins come from walking the response Zod schema
 *
 * The whole pin set rebuilds on every render so edits in the inspector
 * immediately reshape the node.
 */

import { useMemo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import {
  computeHttpRequestPins,
  type ComputedPin,
  type HttpRequestData,
} from "../../../lib/node-pins";
import { useFlowExec } from "../../../lib/exec-context";

const METHOD_CLASS: Record<string, string> = {
  GET: s.methodGet,
  POST: s.methodPost,
  PUT: s.methodPut,
  PATCH: s.methodPatch,
  DELETE: s.methodDelete,
};

const DATA_PIN_CLASS: Record<string, string> = {
  string: s.pinString,
  number: s.pinNumber,
  boolean: s.pinBoolean,
  object: s.pinObject,
  array: s.pinArray,
  unknown: s.pinObject,
  null: s.pinObject,
};

export function HttpRequestNode({ id, data, selected }: NodeProps) {
  const d = (data ?? {}) as HttpRequestData;
  const method = (d.method ?? "GET").toUpperCase();
  const url = d.url ?? "";

  const pins = useMemo(() => computeHttpRequestPins(d), [d]);

  const { statuses, errors } = useFlowExec();
  const status = statuses[id] ?? "idle";
  const errorMsg = errors[id];
  const statusClass =
    status === "running"
      ? s.statusRunning
      : status === "ok"
        ? s.statusOk
        : status === "error"
          ? s.statusError
          : status === "pending"
            ? s.statusPending
            : "";

  // Pair inputs and outputs row-by-row so handles align horizontally.
  const rowCount = Math.max(pins.inputs.length, pins.outputs.length);
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    left: pins.inputs[i],
    right: pins.outputs[i],
  }));

  return (
    <div className={clsx(s.node, selected && s.nodeSelected, statusClass)}>
      <div className={`${s.header} ${s.headerHttp}`}>
        <span className={clsx(s.method, METHOD_CLASS[method] ?? s.methodGet)}>{method}</span>
        <span className={s.headerTitle}>HTTP Request</span>
        {status !== "idle" && <span className={s.statusDot} />}
      </div>

      <div className={s.body}>
        <div className={s.urlText} title={url}>
          {url || <span className={s.muted}>no url set</span>}
        </div>
        {status === "error" && errorMsg && (
          <div className={s.errorText} title={errorMsg}>
            {errorMsg.slice(0, 80)}
          </div>
        )}
      </div>

      {rows.map((row, i) => (
        <div className={s.pinRow} key={i}>
          {row.left ? <PinLabel pin={row.left} /> : <span className={s.pinSpacer} />}
          {row.right ? <PinLabel pin={row.right} /> : <span className={s.pinSpacer} />}
        </div>
      ))}
    </div>
  );
}

function PinLabel({ pin }: { pin: ComputedPin }) {
  const isLeft = pin.side === "left";
  const handleClass = pin.kind === "exec" ? s.pinExec : DATA_PIN_CLASS[pin.dataType ?? "unknown"];
  const handle = (
    <Handle
      id={pin.id}
      type={isLeft ? "target" : "source"}
      position={isLeft ? Position.Left : Position.Right}
      className={`${s.pin} ${handleClass}`}
    />
  );
  return (
    <div className={isLeft ? s.pinLabelLeft : s.pinLabelRight}>
      {isLeft && handle}
      <span className={s.pinName}>{pin.label}</span>
      {!isLeft && handle}
    </div>
  );
}
