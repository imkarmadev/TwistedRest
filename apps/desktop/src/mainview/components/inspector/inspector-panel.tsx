/**
 * Right-side inspector. Shows when a node is selected and edits its `data`
 * via the `onChange` callback. The canvas applies the change which then
 * triggers the debounced autosave.
 *
 * Phase 3 supports HttpRequest nodes (the most config-heavy kind). Other
 * kinds get a minimal "no editable fields" placeholder.
 */

import { useMemo, useState } from "react";
import type { Node } from "@xyflow/react";
import { zodFromJson, type DataType } from "@twistedflow/core";
import { evalZodSchema } from "../../lib/eval-schema";
import { copyCurlToClipboard } from "../../lib/copy-curl";
import type { Environment } from "../../use-tauri";
import type { FlowVariable } from "../../lib/variables-context";
import { JsonToZodModal } from "./json-to-zod-modal";
import s from "./inspector-panel.module.css";

interface InspectorPanelProps {
  node: Node | null;
  onChange: (nodeId: string, data: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  /**
   * Environments are passed in directly because the InspectorPanel lives
   * outside the FlowCanvas's FlowExecContext.Provider tree. Reaching for
   * the context here would only return the default empty value.
   */
  environments: Environment[];
  /** Last successful run output keyed by node id, also passed via prop. */
  results: Record<string, Record<string, unknown>>;
  /** Last error message keyed by node id, for failed runs. */
  errors: Record<string, string>;
  /** Raw response body captured on validation failure (for "regenerate schema" action). */
  rawResponses: Record<string, unknown>;
  /**
   * Live type-resolver bound to the current canvas graph. The Convert
   * editor uses this to learn the type of whatever is wired to its input
   * pin so it can filter the target dropdown to sensible options.
   */
  getInputType: (nodeId: string, inputPinId: string) => DataType;
  /** Flow-scoped variable declarations (shown in VariablesPanel when no node selected). */
  flowVariables?: FlowVariable[];
  /** Update the flow's variable declarations. */
  onFlowVariablesChange?: (vars: FlowVariable[]) => void;
}

export function InspectorPanel({
  node,
  onChange,
  onDelete,
  environments,
  results,
  errors,
  rawResponses,
  getInputType,
  flowVariables,
  onFlowVariablesChange,
}: InspectorPanelProps) {
  if (!node) {
    return (
      <aside className={s.panel}>
        <div data-tauri-drag-region className={s.dragHandle} />
        {flowVariables && onFlowVariablesChange ? (
          <>
            <div className={s.header}>
              <span className={s.headerKind}>flow variables</span>
            </div>
            <div className={s.body}>
              <VariablesPanel
                variables={flowVariables}
                onChange={onFlowVariablesChange}
              />
            </div>
          </>
        ) : (
          <div className={s.empty}>Select a node to edit</div>
        )}
      </aside>
    );
  }

  return (
    <aside className={s.panel}>
      <div data-tauri-drag-region className={s.dragHandle} />

      <div className={s.header}>
        <span className={s.headerKind}>{node.type ?? "node"}</span>
        <button className={s.deleteBtn} onClick={() => onDelete(node.id)} title="Delete node">
          ×
        </button>
      </div>

      <div className={s.body}>
        {node.type === "httpRequest" ? (
          <>
            <HttpRequestEditor
              data={(node.data ?? {}) as Record<string, unknown>}
              onChange={(d) => onChange(node.id, d)}
            />
            <LastErrorViewer
              error={errors[node.id]}
              rawResponse={rawResponses[node.id]}
              onUseAsSchema={(zodSrc) =>
                onChange(node.id, {
                  ...(node.data ?? {}),
                  responseSchema: zodSrc,
                })
              }
            />
            <LastResponseViewer result={results[node.id]} />
          </>
        ) : node.type === "envVar" ? (
          <EnvVarEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            environments={environments}
          />
        ) : node.type === "convert" ? (
          <ConvertEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            sourceType={getInputType(node.id, "in:value")}
          />
        ) : node.type === "log" ? (
          <LogEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "function" ? (
          <FunctionEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "makeObject" ? (
          <MakeObjectEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "route" ? (
          <RouteEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "parseBody" ? (
          <ParseBodyEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "setHeaders" ? (
          <SetHeadersEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "cors" ? (
          <CorsEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "verifyAuth" ? (
          <VerifyAuthEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "rateLimit" ? (
          <RateLimitEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "cookie" ? (
          <CookieEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "redirect" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "status", label: "Status Code (301/302/307/308)", placeholder: "302", type: "number" },
              { key: "url", label: "Redirect URL", placeholder: "/new-path or #{url}" },
            ]}
          />
        ) : node.type === "serveStatic" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "rootDir", label: "Root Directory", placeholder: "./public" },
              { key: "indexFile", label: "Index File", placeholder: "index.html" },
              { key: "stripPrefix", label: "Strip Prefix", placeholder: "/static" },
            ]}
          />
        ) : node.type === "match" ? (
          <MatchEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "emitEvent" ? (
          <EmitEventEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "onEvent" ? (
          <OnEventEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
          />
        ) : node.type === "setVariable" ? (
          <SetVariableEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            variables={flowVariables ?? []}
          />
        ) : node.type === "getVariable" ? (
          <VariableEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            variables={flowVariables ?? []}
          />
        ) : node.type === "assert" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "label", label: "Label", placeholder: "should equal 200" },
              { key: "expected", label: "Expected Value (if no input wired)", placeholder: "200" },
            ]}
          />
        ) : node.type === "assertType" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "label", label: "Label", placeholder: "should be string" },
              { key: "expectedType", label: "Expected Type", placeholder: "string" },
            ]}
          />
        ) : node.type === "httpListen" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "port", label: "Port", placeholder: "3000", type: "number" },
              { key: "maxRequests", label: "Max Requests (0 = unlimited)", placeholder: "0", type: "number" },
            ]}
          />
        ) : node.type === "sendResponse" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "status", label: "Status Code", placeholder: "200", type: "number" },
            ]}
          />
        ) : node.type === "routeMatch" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "method", label: "Method (* = any)", placeholder: "GET" },
              { key: "path", label: "Path (* = any)", placeholder: "/health" },
            ]}
          />
        ) : node.type === "shellExec" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "command", label: "Command", placeholder: "echo #{name}" },
              { key: "failOnError", label: "Fail on non-zero exit", type: "boolean" },
            ]}
          />
        ) : node.type === "fileRead" || node.type === "fileWrite" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "path", label: "File Path", placeholder: "/tmp/output.json" },
            ]}
          />
        ) : node.type === "sleep" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "ms", label: "Duration (ms)", placeholder: "1000", type: "number" },
            ]}
          />
        ) : node.type === "exit" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "message", label: "Message (optional)", placeholder: "Health check failed" },
            ]}
          />
        ) : node.type === "regex" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "pattern", label: "Pattern", placeholder: "\\d+" },
              { key: "mode", label: "Mode (match/extract/replace/split)", placeholder: "match" },
              { key: "replacement", label: "Replacement (replace mode)", placeholder: "$1" },
              { key: "caseInsensitive", label: "Case Insensitive", type: "boolean" },
              { key: "global", label: "Global (all matches)", type: "boolean" },
            ]}
          />
        ) : node.type === "template" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "template", label: "Template", placeholder: "Hello #{name}, you are #{age}!" },
            ]}
          />
        ) : node.type === "encodeDecode" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "encoding", label: "Encoding (base64/hex/url)", placeholder: "base64" },
              { key: "direction", label: "Direction (encode/decode)", placeholder: "encode" },
            ]}
          />
        ) : node.type === "filter" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "expression", label: "Expression", placeholder: "item.status == 200" },
            ]}
          />
        ) : node.type === "map" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "mode", label: "Mode (pluck/pick/template)", placeholder: "pluck" },
              { key: "field", label: "Field (pluck mode)", placeholder: "name" },
              { key: "template", label: "Template (template mode)", placeholder: "#{name}: #{value}" },
            ]}
          />
        ) : node.type === "reduce" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "operation", label: "Operation (sum/count/join/min/max/flatten/unique/groupBy)", placeholder: "sum" },
              { key: "field", label: "Field (for groupBy)", placeholder: "id" },
              { key: "separator", label: "Separator (for join)", placeholder: ", " },
            ]}
          />
        ) : node.type === "retry" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "maxRetries", label: "Max Retries", placeholder: "3", type: "number" },
              { key: "delayMs", label: "Initial Delay (ms)", placeholder: "1000", type: "number" },
              { key: "backoffMultiplier", label: "Backoff Multiplier", placeholder: "2.0", type: "number" },
            ]}
          />
        ) : node.type === "prompt" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "message", label: "Prompt Message", placeholder: "Enter value:" },
              { key: "mode", label: "Mode (text/confirm/password)", placeholder: "text" },
              { key: "default", label: "Default Value", placeholder: "" },
            ]}
          />
        ) : node.type === "merge" ? (
          <SystemFieldEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
            fields={[
              { key: "mode", label: "Mode (auto/deep/shallow/concat)", placeholder: "auto" },
            ]}
          />
        ) : node.type === "start" ? (
          <div className={s.hint}>
            Start node — entry point. The Environment dropdown lives on the
            node body itself.
          </div>
        ) : (
          <div className={s.hint}>No editable fields.</div>
        )}
      </div>
    </aside>
  );
}

// ─── Variables Panel (shown when no node is selected) ──────────

const VAR_TYPES: Array<{ value: DataType; label: string }> = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "object", label: "object" },
  { value: "array", label: "array" },
];

interface VariablesPanelProps {
  variables: FlowVariable[];
  onChange: (vars: FlowVariable[]) => void;
}

function VariablesPanel({ variables, onChange }: VariablesPanelProps) {
  const addVar = () =>
    onChange([...variables, { name: "", type: "string", default: "" }]);
  const removeVar = (i: number) =>
    onChange(variables.filter((_, idx) => idx !== i));
  const updateVar = (i: number, patch: Partial<FlowVariable>) =>
    onChange(variables.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Declared Variables</label>
          <button className={s.smallBtn} onClick={addVar}>
            + add
          </button>
        </div>
        {variables.length === 0 && (
          <div className={s.subtleHint}>
            No variables declared. Add typed variables here and use them in
            Set/Get Variable nodes.
          </div>
        )}
        {variables.map((v, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
            <div className={s.headerRow}>
              <input
                className={s.input}
                value={v.name}
                onChange={(e) => updateVar(i, { name: e.target.value })}
                placeholder="name"
                spellCheck={false}
              />
              <select
                className={s.input}
                style={{ flex: "0 0 80px" }}
                value={v.type}
                onChange={(e) => updateVar(i, { type: e.target.value as DataType })}
              >
                {VAR_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button className={s.removeBtn} onClick={() => removeVar(i)}>
                ×
              </button>
            </div>
            <input
              className={s.input}
              value={v.default ?? ""}
              onChange={(e) => updateVar(i, { default: e.target.value })}
              placeholder="default value"
              spellCheck={false}
            />
          </div>
        ))}
        <div className={s.schemaHint}>
          Variables are scoped to this flow. Set Variable / Get Variable nodes
          will show a dropdown of declared names. Types determine pin colors
          and schema resolution. Defaults are pre-seeded at execution start.
        </div>
      </div>
    </div>
  );
}

// ─── HTTP Request editor ────────────────────────────────────────

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

interface HttpRequestEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function HttpRequestEditor({ data, onChange }: HttpRequestEditorProps) {
  const method = (data.method as string) ?? "GET";
  const url = (data.url as string) ?? "";
  const body = (data.body as string) ?? "";
  const headers =
    (data.headers as Array<{ key: string; value: string; enabled?: boolean }>) ?? [];
  const responseSchema = (data.responseSchema as string) ?? "z.object({\n  \n})";

  const schemaResult = useMemo(() => evalZodSchema(responseSchema), [responseSchema]);
  const [showJsonModal, setShowJsonModal] = useState(false);

  const update = (patch: Record<string, unknown>) => onChange({ ...data, ...patch });

  return (
    <div className={s.form}>
      {/* method + url */}
      <div className={s.field}>
        <label className={s.label}>Request</label>
        <div className={s.urlRow}>
          <select
            className={s.methodSelect}
            value={method}
            onChange={(e) => update({ method: e.target.value })}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className={s.input}
            value={url}
            onChange={(e) => update({ url: e.target.value })}
            placeholder="https://api.example.com/users/#{userId}"
            spellCheck={false}
          />
        </div>
      </div>

      {/* headers */}
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Headers</label>
          <button
            className={s.smallBtn}
            onClick={() =>
              update({
                headers: [...headers, { key: "", value: "", enabled: true }],
              })
            }
          >
            + add
          </button>
        </div>
        {headers.length === 0 && <div className={s.subtleHint}>No headers</div>}
        {headers.map((h, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={h.key}
              onChange={(e) => {
                const next = [...headers];
                next[i] = { ...next[i]!, key: e.target.value };
                update({ headers: next });
              }}
              placeholder="key"
              spellCheck={false}
            />
            <input
              className={s.input}
              value={h.value}
              onChange={(e) => {
                const next = [...headers];
                next[i] = { ...next[i]!, value: e.target.value };
                update({ headers: next });
              }}
              placeholder="value or #{token}"
              spellCheck={false}
            />
            <button
              className={s.removeBtn}
              onClick={() => update({ headers: headers.filter((_, j) => j !== i) })}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* body — hidden for methods that don't carry one (HTTP semantics) */}
      {method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && (
        <div className={s.field}>
          <label className={s.label}>Body</label>
          <textarea
            className={s.textarea}
            value={body}
            rows={5}
            onChange={(e) => update({ body: e.target.value })}
            placeholder='{ "name": "#{name}" }'
            spellCheck={false}
          />
        </div>
      )}

      {/* response schema */}
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Response Schema (Zod)</label>
          <div className={s.schemaActions}>
            <button
              className={s.smallBtn}
              onClick={() => setShowJsonModal(true)}
              title="Generate from a sample JSON response"
            >
              From JSON
            </button>
            <span
              className={schemaResult.ok ? s.statusOk : s.statusErr}
              title={schemaResult.error}
            >
              {schemaResult.ok ? "valid" : "invalid"}
            </span>
          </div>
        </div>
        <textarea
          className={`${s.textarea} ${s.codeArea}`}
          value={responseSchema}
          rows={8}
          onChange={(e) => update({ responseSchema: e.target.value })}
          placeholder="z.object({ id: z.string(), name: z.string() })"
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Each top-level field becomes an output pin on the node.
        </div>
      </div>

      {showJsonModal && (
        <JsonToZodModal
          onApply={(zodSource) => update({ responseSchema: zodSource })}
          onClose={() => setShowJsonModal(false)}
        />
      )}
    </div>
  );
}

// ─── Last error viewer ──────────────────────────────────────────

interface LastErrorViewerProps {
  error: string | undefined;
  /** Raw response body captured on schema-validation failure (if any). */
  rawResponse: unknown;
  /** Called when the user clicks "Use this response as the schema". */
  onUseAsSchema: (zodSource: string) => void;
}

function LastErrorViewer({ error, rawResponse, onUseAsSchema }: LastErrorViewerProps) {
  if (!error) return null;

  // Try to pretty-print Zod validation errors. They start with
  // "Schema validation failed: " followed by a JSON-ish array.
  let pretty = error;
  const zodPrefix = "Schema validation failed: ";
  if (error.startsWith(zodPrefix)) {
    try {
      const parsed = JSON.parse(error.slice(zodPrefix.length));
      pretty = `Schema validation failed:\n${JSON.stringify(parsed, null, 2)}`;
    } catch {
      // fall through with raw text
    }
  }

  const canRegenerate = rawResponse !== undefined;

  return (
    <div className={s.responseSection}>
      <div className={s.responseHeader}>
        <span className={s.label} style={{ color: "#fca5a5" }}>
          Last Error
        </span>
        {canRegenerate && (
          <button
            className={s.smallBtn}
            onClick={() => onUseAsSchema(zodFromJson(rawResponse))}
            title="Replace the response schema with one generated from the actual response body"
          >
            Use response as schema
          </button>
        )}
      </div>
      <pre className={`${s.responseBody} ${s.errorBody}`}>{pretty}</pre>
      {canRegenerate && (
        <details className={s.detailsBlock}>
          <summary className={s.detailsSummary}>Show actual response</summary>
          <pre className={s.responseBody}>
            {JSON.stringify(rawResponse, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// ─── Last response viewer ───────────────────────────────────────

interface LastResponseViewerProps {
  result: Record<string, unknown> | undefined;
}

function LastResponseViewer({ result }: LastResponseViewerProps) {
  const [openResponse, setOpenResponse] = useState(true);
  const [openRequest, setOpenRequest] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);

  if (!result || Object.keys(result).length === 0) {
    return (
      <div className={s.responseSection}>
        <div className={s.responseHeader}>
          <span className={s.label}>Last Run</span>
          <span className={s.subtleHint}>—</span>
        </div>
        <div className={s.subtleHint}>Run the flow to see the request/response here.</div>
      </div>
    );
  }

  // Separate the _request metadata from the response body fields
  const req = result._request as
    | { method?: string; url?: string; headers?: Record<string, string>; status?: number }
    | undefined;
  const responseFields = Object.fromEntries(
    Object.entries(result).filter(([k]) => !k.startsWith("_")),
  );

  return (
    <div className={s.responseSection}>
      {/* Request details (method, resolved URL, all headers including auth) */}
      {req && (
        <>
          <div className={s.responseHeader}>
            <button
              type="button"
              className={s.responseHeaderToggle}
              onClick={() => setOpenRequest((v) => !v)}
              style={{ flex: 1 }}
            >
              <span className={s.label}>
                Request — {req.method} {req.status}
              </span>
              <span className={s.chevron}>{openRequest ? "▾" : "▸"}</span>
            </button>
            <button
              className={s.smallBtn}
              onClick={async () => {
                const ok = await copyCurlToClipboard(result);
                if (ok) {
                  setCurlCopied(true);
                  setTimeout(() => setCurlCopied(false), 2000);
                }
              }}
              title="Copy as curl command"
            >
              {curlCopied ? "Copied!" : "curl"}
            </button>
          </div>
          {openRequest && (
            <pre className={s.responseBody}>
              {`${req.method} ${req.url}\n\n${Object.entries(req.headers ?? {})
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")}`}
            </pre>
          )}
        </>
      )}

      {/* Response body */}
      <button
        type="button"
        className={s.responseHeaderToggle}
        onClick={() => setOpenResponse((v) => !v)}
      >
        <span className={s.label}>Response</span>
        <span className={s.chevron}>{openResponse ? "▾" : "▸"}</span>
      </button>
      {openResponse && (
        <pre className={s.responseBody}>
          {JSON.stringify(responseFields, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─── Convert editor ─────────────────────────────────────────────

interface ConvertEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  /** Type of whatever is wired to the convert's input pin. */
  sourceType: DataType;
}

interface ConvertTarget {
  value: string;
  label: string;
  hint: string;
}

const ALL_TARGETS: ConvertTarget[] = [
  { value: "string", label: "String", hint: 'Number → "1", boolean → "true", object → JSON' },
  { value: "number", label: "Number", hint: '"3.14" → 3.14, true → 1, "" → NaN' },
  { value: "integer", label: "Integer", hint: '"3.9" → 3, "x" → NaN' },
  { value: "boolean", label: "Boolean", hint: '"true"/"1" → true, "false"/"0"/"" → false' },
  { value: "json", label: "JSON Text", hint: "Always JSON.stringify(value)" },
];

/**
 * Which conversions make sense from each source type. The current target
 * is always allowed (so the dropdown doesn't break when you re-wire) but
 * it's flagged as "lossy" or "no-op" via the hint.
 */
const ALLOWED_BY_SOURCE: Record<DataType, string[]> = {
  string: ["number", "integer", "boolean", "json"],
  number: ["string", "integer", "boolean", "json"],
  boolean: ["string", "number", "integer", "json"],
  object: ["string", "json"],
  array: ["string", "json"],
  null: ["string", "json"],
  unknown: ["string", "number", "integer", "boolean", "json"],
};

function ConvertEditor({ data, onChange, sourceType }: ConvertEditorProps) {
  const targetType = (data.targetType as string) ?? "string";
  const allowed = ALLOWED_BY_SOURCE[sourceType] ?? ALL_TARGETS.map((t) => t.value);
  // Always include the currently-selected target in the option list, even
  // if it's no longer "valid" for the current source — otherwise the
  // dropdown would silently swap selection on the user.
  const visible = ALL_TARGETS.filter(
    (t) => allowed.includes(t.value) || t.value === targetType,
  );
  const current = ALL_TARGETS.find((t) => t.value === targetType);
  const isInvalidForSource =
    sourceType !== "unknown" && !allowed.includes(targetType);

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Source Type</label>
        <div className={s.input} style={{ cursor: "default", opacity: 0.85 }}>
          {sourceType === "unknown" ? "(not connected)" : sourceType}
        </div>
        {sourceType === "unknown" && (
          <div className={s.subtleHint}>
            Wire something into the input pin and the available conversions
            will narrow.
          </div>
        )}
      </div>

      <div className={s.field}>
        <label className={s.label}>Target Type</label>
        <select
          className={s.input}
          value={targetType}
          onChange={(e) => onChange({ ...data, targetType: e.target.value })}
        >
          {visible.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
              {!allowed.includes(t.value) ? " (not valid for source)" : ""}
            </option>
          ))}
        </select>
        {current && <div className={s.subtleHint}>{current.hint}</div>}
        {isInvalidForSource && (
          <div className={s.subtleHint} style={{ color: "#fca5a5" }}>
            This target doesn't make sense from a {sourceType}. Pick another
            target or rewire the input.
          </div>
        )}
        <div className={s.schemaHint}>
          Coerces the input value to the chosen type at execution time.
        </div>
      </div>
    </div>
  );
}

// ─── Match editor ───────────────────────────────────────────────

interface MatchEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

interface MatchCaseDef {
  value: string;
  label?: string;
}

function MatchEditor({ data, onChange }: MatchEditorProps) {
  const cases = ((data.cases as MatchCaseDef[]) ?? []) as MatchCaseDef[];
  const updateCases = (next: MatchCaseDef[]) =>
    onChange({ ...data, cases: next });

  const addCase = () => updateCases([...cases, { value: "", label: "" }]);
  const removeCase = (i: number) =>
    updateCases(cases.filter((_, idx) => idx !== i));
  const updateCase = (i: number, patch: Partial<MatchCaseDef>) =>
    updateCases(cases.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Cases</label>
          <button className={s.smallBtn} onClick={addCase}>
            + add
          </button>
        </div>
        {cases.length === 0 && (
          <div className={s.subtleHint}>
            No cases — only the default branch will fire.
          </div>
        )}
        {cases.map((c, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={c.value}
              onChange={(e) => updateCase(i, { value: e.target.value })}
              placeholder="match value"
              spellCheck={false}
            />
            <input
              className={s.input}
              value={c.label ?? ""}
              onChange={(e) => updateCase(i, { label: e.target.value })}
              placeholder="label (optional)"
              spellCheck={false}
            />
            <button className={s.removeBtn} onClick={() => removeCase(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.schemaHint}>
          The value input is compared against each case (string equality).
          The first match fires that case's exec output. If no case matches,
          the <strong>default</strong> output fires.
        </div>
      </div>
    </div>
  );
}

// ─── Route editor ──────────────────────────────────────────────

const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"] as const;

interface RouteEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

interface RouteDef {
  method: string;
  path: string;
  label?: string;
}

function RouteEditor({ data, onChange }: RouteEditorProps) {
  const routes = ((data.routes as RouteDef[]) ?? []) as RouteDef[];
  const updateRoutes = (next: RouteDef[]) =>
    onChange({ ...data, routes: next });

  const addRoute = () => updateRoutes([...routes, { method: "GET", path: "/", label: "" }]);
  const removeRoute = (i: number) =>
    updateRoutes(routes.filter((_, idx) => idx !== i));
  const updateRoute = (i: number, patch: Partial<RouteDef>) =>
    updateRoutes(routes.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Routes</label>
          <button className={s.smallBtn} onClick={addRoute}>
            + add
          </button>
        </div>
        {routes.length === 0 && (
          <div className={s.subtleHint}>
            No routes — only the "not found" branch will fire.
          </div>
        )}
        {routes.map((r, i) => (
          <div className={s.headerRow} key={i}>
            <select
              className={s.input}
              style={{ flex: "0 0 80px" }}
              value={r.method}
              onChange={(e) => updateRoute(i, { method: e.target.value })}
            >
              {ROUTE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className={s.input}
              value={r.path}
              onChange={(e) => updateRoute(i, { path: e.target.value })}
              placeholder="/users/:id"
              spellCheck={false}
            />
            <input
              className={s.input}
              style={{ flex: "0 0 80px" }}
              value={r.label ?? ""}
              onChange={(e) => updateRoute(i, { label: e.target.value })}
              placeholder="label"
              spellCheck={false}
            />
            <button className={s.removeBtn} onClick={() => removeRoute(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.schemaHint}>
          Each route gets its own exec output. Use <code>:param</code> in
          paths to extract parameters (e.g. <code>/users/:id</code>).
          Extracted params are available on the <strong>params</strong> output pin.
          The first matching route wins.
        </div>
      </div>
    </div>
  );
}

// ─── Parse Body editor ─────────────────────────────────────────

const PARSE_BODY_MODES = [
  { value: "auto", label: "Auto-detect" },
  { value: "json", label: "JSON" },
  { value: "form", label: "Form (URL-encoded)" },
  { value: "text", label: "Plain text" },
] as const;

interface ParseBodyEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function ParseBodyEditor({ data, onChange }: ParseBodyEditorProps) {
  const expect = (data.expect as string) ?? "auto";

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Parse Mode</label>
        <select
          className={s.input}
          value={expect}
          onChange={(e) => onChange({ ...data, expect: e.target.value })}
        >
          {PARSE_BODY_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <div className={s.schemaHint}>
          <strong>Auto-detect</strong> reads the Content-Type header.
          Force a mode to skip detection.
          The <strong>parsed</strong> output pin emits the structured value.
        </div>
      </div>
    </div>
  );
}

// ─── Set Headers editor ────────────────────────────────────────

interface SetHeadersEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

interface HeaderDef {
  key: string;
  value: string;
  enabled?: boolean;
}

function SetHeadersEditor({ data, onChange }: SetHeadersEditorProps) {
  const headers = ((data.headers as HeaderDef[]) ?? []) as HeaderDef[];
  const updateHeaders = (next: HeaderDef[]) =>
    onChange({ ...data, headers: next });

  const addHeader = () =>
    updateHeaders([...headers, { key: "", value: "", enabled: true }]);
  const removeHeader = (i: number) =>
    updateHeaders(headers.filter((_, idx) => idx !== i));
  const updateHeader = (i: number, patch: Partial<HeaderDef>) =>
    updateHeaders(headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Headers</label>
          <button className={s.smallBtn} onClick={addHeader}>
            + add
          </button>
        </div>
        {headers.length === 0 && (
          <div className={s.subtleHint}>No headers configured.</div>
        )}
        {headers.map((h, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={h.key}
              onChange={(e) => updateHeader(i, { key: e.target.value })}
              placeholder="Header-Name"
              spellCheck={false}
            />
            <input
              className={s.input}
              value={h.value}
              onChange={(e) => updateHeader(i, { value: e.target.value })}
              placeholder="value or #{token}"
              spellCheck={false}
            />
            <button className={s.removeBtn} onClick={() => removeHeader(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.schemaHint}>
          Use <code>{"#{name}"}</code> in values to reference wired input pins.
          Wire an object into <strong>merge</strong> to combine with upstream headers.
        </div>
      </div>
    </div>
  );
}

// ─── CORS editor ───────────────────────────────────────────────

interface CorsEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function CorsEditor({ data, onChange }: CorsEditorProps) {
  const update = (patch: Record<string, unknown>) =>
    onChange({ ...data, ...patch });

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Allow Origins</label>
        <input
          className={s.input}
          value={(data.allowOrigins as string) ?? "*"}
          onChange={(e) => update({ allowOrigins: e.target.value })}
          placeholder="* or https://example.com, https://app.example.com"
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Use <code>*</code> for all origins, or a comma-separated list.
        </div>
      </div>
      <div className={s.field}>
        <label className={s.label}>Allow Methods</label>
        <input
          className={s.input}
          value={(data.allowMethods as string) ?? "GET, POST, PUT, DELETE, PATCH, OPTIONS"}
          onChange={(e) => update({ allowMethods: e.target.value })}
          spellCheck={false}
        />
      </div>
      <div className={s.field}>
        <label className={s.label}>Allow Headers</label>
        <input
          className={s.input}
          value={(data.allowHeaders as string) ?? "Content-Type, Authorization"}
          onChange={(e) => update({ allowHeaders: e.target.value })}
          spellCheck={false}
        />
      </div>
      <div className={s.field}>
        <label className={s.label}>Max Age (seconds)</label>
        <input
          className={s.input}
          type="number"
          value={String(data.maxAge ?? 86400)}
          onChange={(e) => update({ maxAge: Number(e.target.value) || 0 })}
        />
      </div>
      <div className={s.field}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!data.allowCredentials}
            onChange={(e) => update({ allowCredentials: e.target.checked })}
          />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Allow Credentials
          </span>
        </label>
      </div>
    </div>
  );
}

// ─── Verify Auth editor ────────────────────────────────────────

const AUTH_MODES = [
  { value: "bearer", label: "Bearer (extract only)" },
  { value: "jwt", label: "JWT (HS256 verify)" },
  { value: "apiKey", label: "API Key" },
  { value: "basic", label: "Basic Auth" },
] as const;

interface VerifyAuthEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function VerifyAuthEditor({ data, onChange }: VerifyAuthEditorProps) {
  const mode = (data.mode as string) ?? "bearer";
  const update = (patch: Record<string, unknown>) =>
    onChange({ ...data, ...patch });

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Auth Mode</label>
        <select
          className={s.input}
          value={mode}
          onChange={(e) => update({ mode: e.target.value })}
        >
          {AUTH_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {mode === "jwt" && (
        <div className={s.field}>
          <label className={s.label}>JWT Secret</label>
          <input
            className={s.input}
            type="password"
            value={(data.jwtSecret as string) ?? ""}
            onChange={(e) => update({ jwtSecret: e.target.value })}
            placeholder="or wire in:secret from Env Var"
            spellCheck={false}
          />
          <div className={s.schemaHint}>
            HS256 only. Wire <strong>in:secret</strong> from an Env Var node
            instead of hardcoding here.
          </div>
        </div>
      )}

      {mode === "apiKey" && (
        <>
          <div className={s.field}>
            <label className={s.label}>Header Name</label>
            <input
              className={s.input}
              value={(data.apiKeyHeader as string) ?? "X-API-Key"}
              onChange={(e) => update({ apiKeyHeader: e.target.value })}
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Valid Keys (comma-separated)</label>
            <input
              className={s.input}
              value={(data.apiKeyValues as string) ?? ""}
              onChange={(e) => update({ apiKeyValues: e.target.value })}
              placeholder="key1, key2 — or wire in:validKeys"
              spellCheck={false}
            />
            <div className={s.schemaHint}>
              Leave empty to skip validation (just extract the key).
              Or wire <strong>in:validKeys</strong> array from upstream.
            </div>
          </div>
        </>
      )}

      <div className={s.field}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!data.optional}
            onChange={(e) => update({ optional: e.target.checked })}
          />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Optional (missing auth passes with null claims)
          </span>
        </label>
      </div>
    </div>
  );
}

// ─── Rate Limit editor ─────────────────────────────────────────

interface RateLimitEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

const KEY_SOURCES = [
  { value: "ip", label: "IP Address (X-Forwarded-For)" },
  { value: "header", label: "Custom Header" },
  { value: "custom", label: "Custom (wire in:key)" },
] as const;

function RateLimitEditor({ data, onChange }: RateLimitEditorProps) {
  const keySource = (data.keySource as string) ?? "ip";
  const update = (patch: Record<string, unknown>) =>
    onChange({ ...data, ...patch });

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Max Requests</label>
        <input
          className={s.input}
          type="number"
          value={String(data.maxRequests ?? 100)}
          onChange={(e) => update({ maxRequests: Number(e.target.value) || 100 })}
        />
      </div>
      <div className={s.field}>
        <label className={s.label}>Window (ms)</label>
        <input
          className={s.input}
          type="number"
          value={String(data.windowMs ?? 60000)}
          onChange={(e) => update({ windowMs: Number(e.target.value) || 60000 })}
        />
        <div className={s.schemaHint}>
          60000 = 1 minute, 3600000 = 1 hour
        </div>
      </div>
      <div className={s.field}>
        <label className={s.label}>Key Source</label>
        <select
          className={s.input}
          value={keySource}
          onChange={(e) => update({ keySource: e.target.value })}
        >
          {KEY_SOURCES.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      {keySource === "header" && (
        <div className={s.field}>
          <label className={s.label}>Header Name</label>
          <input
            className={s.input}
            value={(data.keyHeader as string) ?? "X-Forwarded-For"}
            onChange={(e) => update({ keyHeader: e.target.value })}
            spellCheck={false}
          />
        </div>
      )}
      <div className={s.schemaHint}>
        Wire <strong>in:key</strong> to override the key source with a custom
        value (e.g., user ID from Verify Auth claims).
      </div>
    </div>
  );
}

// ─── Cookie editor ─────────────────────────────────────────────

const COOKIE_MODES = [
  { value: "parse", label: "Parse (read cookies)" },
  { value: "set", label: "Set (build Set-Cookie)" },
] as const;

const SAME_SITE_OPTIONS = ["Strict", "Lax", "None"] as const;

interface CookieEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

interface CookieDef {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

function CookieEditor({ data, onChange }: CookieEditorProps) {
  const mode = (data.mode as string) ?? "parse";
  const setCookies = ((data.setCookies as CookieDef[]) ?? []) as CookieDef[];
  const update = (patch: Record<string, unknown>) =>
    onChange({ ...data, ...patch });
  const updateCookies = (next: CookieDef[]) =>
    update({ setCookies: next });

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Mode</label>
        <select
          className={s.input}
          value={mode}
          onChange={(e) => update({ mode: e.target.value })}
        >
          {COOKIE_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {mode === "parse" && (
        <div className={s.schemaHint}>
          Wire <strong>in:headers</strong> from HTTP Listen. The
          <strong> cookies</strong> output pin emits a name-value object.
        </div>
      )}

      {mode === "set" && (
        <div className={s.field}>
          <div className={s.labelRow}>
            <label className={s.label}>Cookies</label>
            <button
              className={s.smallBtn}
              onClick={() =>
                updateCookies([
                  ...setCookies,
                  { name: "", value: "", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
                ])
              }
            >
              + add
            </button>
          </div>
          {setCookies.length === 0 && (
            <div className={s.subtleHint}>No cookies configured.</div>
          )}
          {setCookies.map((c, i) => (
            <div key={i} style={{ marginBottom: 8, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
              <div className={s.headerRow}>
                <input
                  className={s.input}
                  value={c.name}
                  onChange={(e) => {
                    const next = [...setCookies];
                    next[i] = { ...next[i]!, name: e.target.value };
                    updateCookies(next);
                  }}
                  placeholder="name"
                  spellCheck={false}
                />
                <input
                  className={s.input}
                  value={c.value}
                  onChange={(e) => {
                    const next = [...setCookies];
                    next[i] = { ...next[i]!, value: e.target.value };
                    updateCookies(next);
                  }}
                  placeholder="value or #{token}"
                  spellCheck={false}
                />
                <button
                  className={s.removeBtn}
                  onClick={() => updateCookies(setCookies.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
              <div className={s.headerRow} style={{ marginTop: 4 }}>
                <input
                  className={s.input}
                  style={{ flex: "0 0 60px" }}
                  value={c.path ?? "/"}
                  onChange={(e) => {
                    const next = [...setCookies];
                    next[i] = { ...next[i]!, path: e.target.value };
                    updateCookies(next);
                  }}
                  placeholder="path"
                  spellCheck={false}
                />
                <select
                  className={s.input}
                  style={{ flex: "0 0 70px" }}
                  value={c.sameSite ?? "Lax"}
                  onChange={(e) => {
                    const next = [...setCookies];
                    next[i] = { ...next[i]!, sameSite: e.target.value };
                    updateCookies(next);
                  }}
                >
                  {SAME_SITE_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={c.httpOnly ?? false}
                    onChange={(e) => {
                      const next = [...setCookies];
                      next[i] = { ...next[i]!, httpOnly: e.target.checked };
                      updateCookies(next);
                    }}
                  />
                  HttpOnly
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={c.secure ?? false}
                    onChange={(e) => {
                      const next = [...setCookies];
                      next[i] = { ...next[i]!, secure: e.target.checked };
                      updateCookies(next);
                    }}
                  />
                  Secure
                </label>
              </div>
            </div>
          ))}
          <div className={s.schemaHint}>
            Use <code>{"#{name}"}</code> in values to reference wired inputs.
            Wire <strong>setCookieHeaders</strong> into Send Response <strong>in:headers</strong>.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Function editor ────────────────────────────────────────────

interface FunctionEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

interface FnFieldDef {
  key: string;
  type: DataType;
}

const FN_TYPES: Array<{ value: DataType; label: string }> = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "object", label: "object" },
  { value: "array", label: "array" },
  { value: "unknown", label: "any" },
];

function FunctionEditor({ data, onChange }: FunctionEditorProps) {
  const name = (data.name as string) ?? "transform";
  const inputs = ((data.inputs as FnFieldDef[]) ?? []) as FnFieldDef[];
  const outputs = ((data.outputs as FnFieldDef[]) ?? []) as FnFieldDef[];
  const code = (data.code as string) ?? "";

  const update = (patch: Record<string, unknown>) =>
    onChange({ ...data, ...patch });

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Name</label>
        <input
          className={s.input}
          value={name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="transform"
          spellCheck={false}
        />
      </div>

      <FieldListEditor
        label="Inputs"
        fields={inputs}
        onChange={(next) => update({ inputs: next })}
        hint="Each input becomes a property on the `inputs` object in your code."
      />

      <FieldListEditor
        label="Outputs"
        fields={outputs}
        onChange={(next) => update({ outputs: next })}
        hint="Your code must return an object with these keys."
      />

      <div className={s.field}>
        <label className={s.label}>Code</label>
        <textarea
          className={`${s.textarea} ${s.codeArea}`}
          value={code}
          rows={10}
          onChange={(e) => update({ code: e.target.value })}
          placeholder={'return {\n  result: inputs.value.toUpperCase(),\n}'}
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Receives <code>inputs</code> object. Must <code>return</code> an object
          matching the declared outputs.
          <br />
          Example: <code>{`return { result: inputs.value.toUpperCase() }`}</code>
        </div>
      </div>
    </div>
  );
}

/** Shared field list editor for Function inputs/outputs (same pattern as
 *  MakeObject and EmitEvent payload editors). */
function FieldListEditor({
  label,
  fields,
  onChange,
  hint,
}: {
  label: string;
  fields: FnFieldDef[];
  onChange: (next: FnFieldDef[]) => void;
  hint: string;
}) {
  const add = () => onChange([...fields, { key: "", type: "string" }]);
  const remove = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<FnFieldDef>) =>
    onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div className={s.field}>
      <div className={s.labelRow}>
        <label className={s.label}>{label}</label>
        <button className={s.smallBtn} onClick={add}>
          + add
        </button>
      </div>
      {fields.length === 0 && (
        <div className={s.subtleHint}>No {label.toLowerCase()} declared.</div>
      )}
      {fields.map((f, i) => (
        <div className={s.headerRow} key={i}>
          <input
            className={s.input}
            value={f.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="name"
            spellCheck={false}
          />
          <select
            className={s.input}
            style={{ flex: "0 0 90px" }}
            value={f.type}
            onChange={(e) => update(i, { type: e.target.value as DataType })}
          >
            {FN_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button className={s.removeBtn} onClick={() => remove(i)}>
            ×
          </button>
        </div>
      ))}
      <div className={s.schemaHint}>{hint}</div>
    </div>
  );
}

// ─── Log editor ─────────────────────────────────────────────────

interface LogEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function LogEditor({ data, onChange }: LogEditorProps) {
  const label = (data.label as string) ?? "Log";
  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Label</label>
        <input
          className={s.input}
          value={label}
          onChange={(e) => onChange({ ...data, label: e.target.value })}
          placeholder="Log"
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Shown as the entry's label in the bottom Console panel. Helpful
          when you have multiple Log nodes — name them by purpose.
        </div>
      </div>
    </div>
  );
}

// ─── Make Object editor ─────────────────────────────────────────

interface MakeObjectEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

interface MakeObjectFieldDef {
  key: string;
  type: DataType;
}

const MAKE_OBJECT_TYPES: Array<{ value: DataType; label: string }> = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "object", label: "object" },
  { value: "array", label: "array" },
];

function MakeObjectEditor({ data, onChange }: MakeObjectEditorProps) {
  const fields = ((data.fields as MakeObjectFieldDef[]) ?? []) as MakeObjectFieldDef[];
  const updateFields = (next: MakeObjectFieldDef[]) =>
    onChange({ ...data, fields: next });

  const addField = () =>
    updateFields([...fields, { key: "", type: "string" }]);
  const removeField = (i: number) =>
    updateFields(fields.filter((_, idx) => idx !== i));
  const updateField = (i: number, patch: Partial<MakeObjectFieldDef>) =>
    updateFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Fields</label>
          <button className={s.smallBtn} onClick={addField}>
            + add
          </button>
        </div>
        {fields.length === 0 && (
          <div className={s.subtleHint}>
            No fields yet. Add some to expose typed input pins on the node.
          </div>
        )}
        {fields.map((f, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={f.key}
              onChange={(e) => updateField(i, { key: e.target.value })}
              placeholder="fieldName"
              spellCheck={false}
            />
            <select
              className={s.input}
              style={{ flex: "0 0 100px" }}
              value={f.type}
              onChange={(e) =>
                updateField(i, { type: e.target.value as DataType })
              }
            >
              {MAKE_OBJECT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className={s.removeBtn} onClick={() => removeField(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.schemaHint}>
          The output object pin emits <code>{`{ key1: value1, key2: value2, ... }`}</code>
          {" "}assembled from whatever's wired into each input pin.
        </div>
      </div>
    </div>
  );
}

// ─── Emit Event editor ──────────────────────────────────────────

interface EmitEventEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

const PAYLOAD_TYPES: Array<{ value: DataType; label: string }> = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "object", label: "object" },
  { value: "array", label: "array" },
];

interface PayloadFieldDef {
  key: string;
  type: DataType;
}

function EmitEventEditor({ data, onChange }: EmitEventEditorProps) {
  const name = (data.name as string) ?? "";
  const payload = ((data.payload as PayloadFieldDef[]) ?? []) as PayloadFieldDef[];

  const updateName = (next: string) => onChange({ ...data, name: next });
  const updatePayload = (next: PayloadFieldDef[]) =>
    onChange({ ...data, payload: next });

  const addField = () =>
    updatePayload([...payload, { key: "", type: "string" }]);
  const removeField = (i: number) =>
    updatePayload(payload.filter((_, idx) => idx !== i));
  const updateField = (i: number, patch: Partial<PayloadFieldDef>) =>
    updatePayload(payload.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Event Name</label>
        <input
          className={s.input}
          value={name}
          onChange={(e) => updateName(e.target.value)}
          placeholder="userLoaded"
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Listeners with this exact name will fire when this emitter runs.
        </div>
      </div>

      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Payload Fields</label>
          <button className={s.smallBtn} onClick={addField}>
            + add
          </button>
        </div>
        {payload.length === 0 && (
          <div className={s.subtleHint}>
            No payload fields yet. Add some to expose typed input pins on the
            emitter and matching output pins on listeners.
          </div>
        )}
        {payload.map((f, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={f.key}
              onChange={(e) => updateField(i, { key: e.target.value })}
              placeholder="fieldName"
              spellCheck={false}
            />
            <select
              className={s.input}
              style={{ flex: "0 0 100px" }}
              value={f.type}
              onChange={(e) =>
                updateField(i, { type: e.target.value as DataType })
              }
            >
              {PAYLOAD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className={s.removeBtn} onClick={() => removeField(i)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── On Event editor ────────────────────────────────────────────

interface OnEventEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function OnEventEditor({ data, onChange }: OnEventEditorProps) {
  const name = (data.name as string) ?? "";

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Event Name</label>
        <input
          className={s.input}
          value={name}
          onChange={(e) => onChange({ ...data, name: e.target.value })}
          placeholder="userLoaded"
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Must match an Emit Event's name exactly. Output pins are mirrored
          automatically from the matching emitter's payload — declare them
          on the emitter, not here.
        </div>
      </div>
    </div>
  );
}

// ─── Set Variable editor ────────────────────────────────────────

const SET_VAR_TYPES = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "json", label: "JSON" },
] as const;

interface SetVariableEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  variables: FlowVariable[];
}

function SetVariableEditor({ data, onChange, variables }: SetVariableEditorProps) {
  const varName = (data.varName as string) ?? "";
  const value = (data.value as string) ?? "";
  const valueType = (data.valueType as string) ?? "string";
  const hasDeclared = variables.length > 0;

  // When the user picks a declared variable, auto-set the valueType to match
  const handleVarSelect = (name: string) => {
    const decl = variables.find((v) => v.name === name);
    const patch: Record<string, unknown> = { ...data, varName: name };
    if (decl) {
      // Map declared type to the valueType used by the executor
      const typeMap: Record<string, string> = {
        string: "string",
        number: "number",
        boolean: "boolean",
        object: "json",
        array: "json",
        unknown: "string",
        null: "string",
      };
      patch.valueType = typeMap[decl.type] ?? "string";
    }
    onChange(patch);
  };

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Variable Name</label>
        {hasDeclared ? (
          <select
            className={s.input}
            value={varName}
            onChange={(e) => handleVarSelect(e.target.value)}
          >
            <option value="">-- pick a variable --</option>
            {variables.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.type})
              </option>
            ))}
          </select>
        ) : (
          <input
            className={s.input}
            value={varName}
            onChange={(e) => onChange({ ...data, varName: e.target.value })}
            placeholder="myVariable"
            spellCheck={false}
          />
        )}
        {!hasDeclared && (
          <div className={s.schemaHint}>
            Tip: click empty canvas to declare typed variables in the Variables Panel.
          </div>
        )}
      </div>
      <div className={s.field}>
        <label className={s.label}>Value</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className={s.input}
            style={{ flex: 1 }}
            value={value}
            onChange={(e) => onChange({ ...data, value: e.target.value })}
            placeholder="literal value (or wire in:value pin)"
            spellCheck={false}
          />
          <select
            className={s.input}
            style={{ flex: "0 0 80px" }}
            value={valueType}
            onChange={(e) => onChange({ ...data, valueType: e.target.value })}
          >
            {SET_VAR_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className={s.schemaHint}>
          Set a literal value here, or leave empty and wire the <strong>in:value</strong> pin
          from upstream. Wired pin takes priority over the literal.
        </div>
      </div>
    </div>
  );
}

// ─── Variable (Get) editor ──────────────────────────────────────

interface VariableEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  variables: FlowVariable[];
}

function VariableEditor({ data, onChange, variables }: VariableEditorProps) {
  const varName = (data.varName as string) ?? "";
  const hasDeclared = variables.length > 0;
  const decl = variables.find((v) => v.name === varName);

  // When the user picks a declared variable, stash the type on node data
  // so schema-resolution can read it without accessing the variables context.
  const handleVarSelect = (name: string) => {
    const d = variables.find((v) => v.name === name);
    onChange({ ...data, varName: name, _declaredType: d?.type ?? "unknown" });
  };

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Variable Name</label>
        {hasDeclared ? (
          <select
            className={s.input}
            value={varName}
            onChange={(e) => handleVarSelect(e.target.value)}
          >
            <option value="">-- pick a variable --</option>
            {variables.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.type})
              </option>
            ))}
          </select>
        ) : (
          <input
            className={s.input}
            value={varName}
            onChange={(e) => onChange({ ...data, varName: e.target.value })}
            placeholder="myVariable"
            spellCheck={false}
          />
        )}
        {decl && (
          <div className={s.subtleHint}>
            Type: {decl.type}{decl.default ? ` (default: ${decl.default})` : ""}
          </div>
        )}
        {!hasDeclared && (
          <div className={s.schemaHint}>
            Tip: click empty canvas to declare typed variables in the Variables Panel.
          </div>
        )}
        <div className={s.schemaHint}>
          Reads a runtime variable set by Set Variable.
        </div>
      </div>
    </div>
  );
}

// ─── EnvVar editor ──────────────────────────────────────────────

interface EnvVarEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  environments: Environment[];
}

function EnvVarEditor({ data, onChange, environments }: EnvVarEditorProps) {
  const varKey = (data.varKey as string) ?? "";

  // Collect every unique key defined across the project's environments,
  // so the dropdown stays useful even if the user hasn't picked an env yet.
  const allKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const env of environments) {
      for (const v of env.vars) {
        if (v.key) seen.add(v.key);
      }
    }
    return [...seen].sort();
  }, [environments]);

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Variable</label>
        <select
          className={s.input}
          value={varKey}
          onChange={(e) => onChange({ ...data, varKey: e.target.value })}
        >
          <option value="">— pick a variable —</option>
          {allKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {allKeys.length === 0 && (
          <div className={s.subtleHint}>
            No environment variables defined yet. Open project settings → Environments
            and add some keys.
          </div>
        )}
        <div className={s.schemaHint}>
          The output pin emits this variable's value from whichever environment
          is selected on the Start node at run time.
        </div>
      </div>
    </div>
  );
}

// ─── System field editor (generic for system nodes) ─────────────

interface SystemField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "string" | "number" | "boolean";
}

interface SystemFieldEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  fields: SystemField[];
}

function SystemFieldEditor({ data, onChange, fields }: SystemFieldEditorProps) {
  return (
    <div className={s.form}>
      {fields.map((f) => (
        <div className={s.field} key={f.key}>
          <label className={s.label}>{f.label}</label>
          {f.type === "boolean" ? (
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!data[f.key]}
                onChange={(e) => onChange({ ...data, [f.key]: e.target.checked })}
              />
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {data[f.key] ? "Yes" : "No"}
              </span>
            </label>
          ) : (
            <input
              className={s.input}
              type={f.type === "number" ? "number" : "text"}
              value={String(data[f.key] ?? "")}
              onChange={(e) =>
                onChange({
                  ...data,
                  [f.key]: f.type === "number" ? Number(e.target.value) || 0 : e.target.value,
                })
              }
              placeholder={f.placeholder}
              spellCheck={false}
            />
          )}
        </div>
      ))}
    </div>
  );
}
