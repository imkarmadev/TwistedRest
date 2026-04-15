/**
 * Generic system node component — used by Print, Shell Exec, File Read,
 * File Write, Sleep, Exit. Renders exec pins + configured data pins.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import s from "./node.module.css";
import { pinClass } from "../../../lib/pin-classes";
import { useFlowExec } from "../../../lib/exec-context";
import { inputPinsFor, type DataType } from "@twistedflow/core";

interface SystemNodeConfig {
  badge: string;
  label: string;
  subtitle?: string;
  inputs: Array<{ id: string; label: string; type: DataType }>;
  outputs: Array<{ id: string; label: string; type: DataType }>;
  /** Custom exec-out handle and label (default: "exec-out" / "exec") */
  execOutHandle?: string;
  execOutLabel?: string;
  /** If true, no exec pins at all (pure data node) */
  noExec?: boolean;
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
  httpListen: (data) => ({
    badge: "PROC",
    label: "HTTP Listen",
    subtitle: `:${data.port ?? 3000}`,
    inputs: [],
    outputs: [
      { id: "out:method", label: "method", type: "string" },
      { id: "out:path", label: "path", type: "string" },
      { id: "out:query", label: "query", type: "string" },
      { id: "out:headers", label: "headers", type: "object" },
      { id: "out:body", label: "body", type: "unknown" },
    ],
    execOutHandle: "exec-request",
    execOutLabel: "request",
  }),
  sendResponse: () => ({
    badge: "HTTP",
    label: "Send Response",
    subtitle: "reply to client",
    inputs: [
      { id: "in:status", label: "status", type: "number" },
      { id: "in:body", label: "body", type: "unknown" },
      { id: "in:headers", label: "headers", type: "object" },
    ],
    outputs: [],
  }),
  parseBody: (data) => ({
    badge: "HTTP",
    label: "Parse Body",
    subtitle: (data.expect as string) || "auto",
    inputs: [
      { id: "in:body", label: "body", type: "unknown" },
      { id: "in:headers", label: "headers", type: "object" },
    ],
    outputs: [
      { id: "out:parsed", label: "parsed", type: "unknown" },
      { id: "out:contentType", label: "contentType", type: "string" },
    ],
    noExec: true,
  }),
  assert: (data) => ({
    badge: "TEST",
    label: "Assert",
    subtitle: (data.label as string) || "equals",
    inputs: [
      { id: "in:actual", label: "actual", type: "unknown" },
      { id: "in:expected", label: "expected", type: "unknown" },
    ],
    outputs: [],
  }),
  assertType: (data) => ({
    badge: "TEST",
    label: "Assert Type",
    subtitle: `is ${(data.expectedType as string) || "string"}`,
    inputs: [
      { id: "in:value", label: "value", type: "unknown" },
    ],
    outputs: [],
  }),
  setHeaders: (data) => {
    const hdrs = (data.headers as Array<{ key: string; value: string; enabled?: boolean }>) ?? [];
    const enabledCount = hdrs.filter((h) => h.enabled !== false && h.key).length;
    return {
      badge: "HTTP",
      label: "Set Headers",
      subtitle: `${enabledCount} header${enabledCount === 1 ? "" : "s"}`,
      inputs: [{ id: "in:merge", label: "merge", type: "object" }],
      outputs: [{ id: "out:headers", label: "headers", type: "object" }],
      noExec: true,
    };
  },
  cookie: (data) => {
    const mode = (data.mode as string) || "parse";
    return {
      badge: "HTTP",
      label: "Cookie",
      subtitle: mode,
      inputs: [{ id: "in:headers", label: "headers", type: "object" as DataType }],
      outputs: mode === "set"
        ? [{ id: "out:setCookieHeaders", label: "setCookieHeaders", type: "object" as DataType }]
        : [{ id: "out:cookies", label: "cookies", type: "object" as DataType }],
      noExec: true,
    };
  },
  redirect: (data) => ({
    badge: "HTTP",
    label: "Redirect",
    subtitle: `${data.status ?? 302} → ${(data.url as string)?.slice(0, 20) || "/"}`,
    inputs: [{ id: "in:url", label: "url", type: "string" }],
    outputs: [],
  }),
  serveStatic: (data) => ({
    badge: "HTTP",
    label: "Serve Static",
    subtitle: (data.rootDir as string)?.slice(0, 25) || "./public",
    inputs: [{ id: "in:path", label: "path", type: "string" }],
    outputs: [
      { id: "out:filePath", label: "filePath", type: "string" },
      { id: "out:contentType", label: "contentType", type: "string" },
      { id: "out:found", label: "found", type: "boolean" },
    ],
  }),
  routeMatch: (data) => ({
    badge: "HTTP",
    label: "Route Match",
    subtitle: `${data.method ?? "GET"} ${data.path ?? "/"}`,
    inputs: [
      { id: "in:method", label: "method", type: "string" },
      { id: "in:path", label: "path", type: "string" },
    ],
    outputs: [{ id: "out:matched", label: "matched", type: "boolean" }],
    noExec: true,
  }),
  // ── CLI nodes ──────────────────────────────────────────────────
  parseArgs: () => ({
    badge: "CLI",
    label: "Parse Args",
    subtitle: "argv",
    inputs: [],
    outputs: [
      { id: "out:flags", label: "flags", type: "object" },
      { id: "out:positional", label: "positional", type: "array" },
      { id: "out:raw", label: "raw", type: "array" },
    ],
    noExec: true,
  }),
  stdin: () => ({
    badge: "CLI",
    label: "Stdin",
    subtitle: "read stdin",
    inputs: [],
    outputs: [
      { id: "out:content", label: "content", type: "string" },
      { id: "out:lines", label: "lines", type: "array" },
      { id: "out:json", label: "json", type: "unknown" },
    ],
  }),
  stderr: () => ({
    badge: "CLI",
    label: "Stderr",
    subtitle: "stderr",
    inputs: [{ id: "in:value", label: "value", type: "unknown" }],
    outputs: [],
  }),
  prompt: (data) => ({
    badge: "CLI",
    label: "Prompt",
    subtitle: (data.message as string)?.slice(0, 30) || "? ",
    inputs: [{ id: "in:message", label: "message", type: "string" }],
    outputs: [{ id: "out:answer", label: "answer", type: "string" }],
  }),
  // ── String nodes ───────────────────────────────────────────────
  regex: (data) => ({
    badge: "STR",
    label: "Regex",
    subtitle: (data.pattern as string)?.slice(0, 25) || "pattern",
    inputs: [{ id: "in:value", label: "value", type: "string" }],
    outputs: (() => {
      const mode = (data.mode as string) || "match";
      if (mode === "match") return [
        { id: "out:matched", label: "matched", type: "boolean" as DataType },
        { id: "out:groups", label: "groups", type: "array" as DataType },
      ];
      if (mode === "extract") return [
        { id: "out:matches", label: "matches", type: "array" as DataType },
      ];
      if (mode === "replace") return [
        { id: "out:result", label: "result", type: "string" as DataType },
      ];
      if (mode === "split") return [
        { id: "out:parts", label: "parts", type: "array" as DataType },
      ];
      return [{ id: "out:result", label: "result", type: "string" as DataType }];
    })(),
    noExec: true,
  }),
  template: (data) => {
    const tmpl = (data.template as string) || "";
    const tokens = inputPinsFor(tmpl);
    const inputs = tokens.length > 0
      ? tokens.map((name) => ({ id: `in:${name}`, label: name, type: "unknown" as DataType }))
      : [{ id: "in:value", label: "value", type: "unknown" as DataType }];
    return {
      badge: "STR",
      label: "Template",
      subtitle: tmpl.slice(0, 25) || "#{var}",
      inputs,
      outputs: [{ id: "out:result", label: "result", type: "string" as DataType }],
      noExec: true,
    };
  },
  encodeDecode: (data) => ({
    badge: "STR",
    label: "Encode/Decode",
    subtitle: `${data.encoding ?? "base64"} ${data.direction ?? "encode"}`,
    inputs: [{ id: "in:value", label: "value", type: "string" }],
    outputs: [{ id: "out:result", label: "result", type: "string" }],
    noExec: true,
  }),
  hash: (data) => ({
    badge: "STR",
    label: "Hash",
    subtitle: (data.algorithm as string) || "sha256",
    inputs: [
      { id: "in:value", label: "value", type: "string" },
      ...((data.algorithm as string) === "hmac-sha256" ? [{ id: "in:key", label: "key", type: "string" as DataType }] : []),
    ],
    outputs: [{ id: "out:hash", label: "hash", type: "string" }],
    noExec: true,
  }),
  // ── Data transform nodes ──────────────────────────────────────
  filter: (data) => ({
    badge: "DATA",
    label: "Filter",
    subtitle: (data.expression as string)?.slice(0, 25) || "expression",
    inputs: [{ id: "in:array", label: "array", type: "array" }],
    outputs: [
      { id: "out:result", label: "result", type: "array" },
      { id: "out:count", label: "count", type: "number" },
    ],
  }),
  map: (data) => ({
    badge: "DATA",
    label: "Map",
    subtitle: (data.mode as string) || "pluck",
    inputs: [{ id: "in:array", label: "array", type: "array" }],
    outputs: [
      { id: "out:result", label: "result", type: "array" },
      { id: "out:count", label: "count", type: "number" },
    ],
  }),
  merge: (data) => ({
    badge: "DATA",
    label: "Merge",
    subtitle: (data.mode as string) || "auto",
    inputs: [
      { id: "in:a", label: "a", type: "unknown" },
      { id: "in:b", label: "b", type: "unknown" },
    ],
    outputs: [{ id: "out:result", label: "result", type: "unknown" }],
    noExec: true,
  }),
  reduce: (data) => ({
    badge: "DATA",
    label: "Reduce",
    subtitle: (data.operation as string) || "sum",
    inputs: [{ id: "in:array", label: "array", type: "array" }],
    outputs: [{ id: "out:result", label: "result", type: "unknown" }],
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
      {!config.noExec && (
        <div className={s.pinRow}>
          <div className={s.pinLabelLeft}>
            <Handle id="exec-in" type="target" position={Position.Left} className={`${s.pin} ${s.pinExec}`} />
            <span className={s.pinName}>exec</span>
          </div>
          {config.execOutHandle !== "__none__" ? (
            <div className={s.pinLabelRight}>
              <span className={s.pinName}>{config.execOutLabel ?? "exec"}</span>
              <Handle id={config.execOutHandle ?? "exec-out"} type="source" position={Position.Right} className={`${s.pin} ${s.pinExec}`} />
            </div>
          ) : (
            <span className={s.pinSpacer} />
          )}
        </div>
      )}

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
