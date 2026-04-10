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
}: InspectorPanelProps) {
  if (!node) {
    return (
      <aside className={s.panel}>
        <div data-tauri-drag-region className={s.dragHandle} />
        <div className={s.empty}>Select a node to edit</div>
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
        ) : node.type === "setVariable" || node.type === "getVariable" ? (
          <VariableEditor
            data={(node.data ?? {}) as Record<string, unknown>}
            onChange={(d) => onChange(node.id, d)}
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

// ─── Variable (Set/Get) editor ──────────────────────────────────

interface VariableEditorProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function VariableEditor({ data, onChange }: VariableEditorProps) {
  const varName = (data.varName as string) ?? "";

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Variable Name</label>
        <input
          className={s.input}
          value={varName}
          onChange={(e) => onChange({ ...data, varName: e.target.value })}
          placeholder="myVariable"
          spellCheck={false}
        />
        <div className={s.schemaHint}>
          Runtime flow variable. Use <strong>Set Variable</strong> to write
          and <strong>Get Variable</strong> to read. Undefined reads show as errors.
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
