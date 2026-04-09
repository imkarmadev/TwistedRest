/**
 * Project Settings modal.
 *
 * Two tabs:
 *   - General — name, base URL, default headers (header values support
 *     `#{token}` templating just like nodes)
 *   - Environments — list of named env bags, each with key/value vars.
 *     The active env is selected on the Start node, not here.
 *
 * Saves are immediate via Tauri commands. After every mutation we call
 * `onChanged` so the parent re-fetches and the canvas/Start node see
 * fresh data.
 */

import { useEffect, useState } from "react";
import clsx from "clsx";
import type {
  RPC,
  ProjectDetail,
  Environment,
  HeaderEntry,
  EnvVar,
  AuthConfig,
  AuthType,
} from "../../use-tauri";
import s from "./project-settings-modal.module.css";

interface ProjectSettingsModalProps {
  rpc: RPC;
  project: ProjectDetail;
  environments: Environment[];
  onClose: () => void;
  onChanged: () => void;
}

type Tab = "general" | "environments";

export function ProjectSettingsModal({
  rpc,
  project,
  environments,
  onClose,
  onChanged,
}: ProjectSettingsModalProps) {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <span className={s.title}>Project Settings</span>
          <button className={s.closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        <div className={s.tabs}>
          <button
            className={clsx(s.tab, tab === "general" && s.tabActive)}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            className={clsx(s.tab, tab === "environments" && s.tabActive)}
            onClick={() => setTab("environments")}
          >
            Environments
          </button>
        </div>

        <div className={s.body}>
          {tab === "general" && (
            <GeneralTab rpc={rpc} project={project} onChanged={onChanged} />
          )}
          {tab === "environments" && (
            <EnvironmentsTab
              rpc={rpc}
              project={project}
              environments={environments}
              onChanged={onChanged}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── General tab ────────────────────────────────────────────────

function GeneralTab({
  rpc,
  project,
  onChanged,
}: {
  rpc: RPC;
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [headers, setHeaders] = useState<HeaderEntry[]>(project.headers);
  const [saving, setSaving] = useState(false);

  // Sync local state when project changes externally
  useEffect(() => {
    setName(project.name);
    setHeaders(project.headers);
  }, [project]);

  const save = async () => {
    setSaving(true);
    // Base URL stays where it is on the project record (legacy fallback);
    // we no longer expose it in the UI because users want it per-env.
    await rpc.request.updateProject({
      id: project.id,
      name,
      baseUrl: project.baseUrl,
      headers,
    });
    setSaving(false);
    onChanged();
  };

  const addHeader = () =>
    setHeaders([...headers, { key: "", value: "", enabled: true }]);

  const removeHeader = (idx: number) =>
    setHeaders(headers.filter((_, i) => i !== idx));

  const updateHeader = (idx: number, patch: Partial<HeaderEntry>) =>
    setHeaders(headers.map((h, i) => (i === idx ? { ...h, ...patch } : h)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Name</label>
        <input
          className={s.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Default Headers</label>
          <button className={s.smallBtn} onClick={addHeader}>
            + add
          </button>
        </div>
        {headers.length === 0 && (
          <div className={s.subtleHint}>None — every request goes out bare.</div>
        )}
        {headers.map((h, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={h.key}
              onChange={(e) => updateHeader(i, { key: e.target.value })}
              placeholder="key"
              spellCheck={false}
            />
            <input
              className={s.input}
              value={h.value}
              onChange={(e) => updateHeader(i, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
            />
            <button className={s.removeBtn} onClick={() => removeHeader(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.hint}>
          General headers, identical across every environment. Environment-level
          headers override these on key conflict, and node-level headers override
          both.
        </div>
      </div>

      <div className={s.subtleHint}>
        Base URLs and per-env headers live under the <strong>Environments</strong>{" "}
        tab — most projects need different URLs for dev / staging / prod.
      </div>

      <div className={s.actions}>
        <button className={s.primaryBtn} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ─── Environments tab ───────────────────────────────────────────

function EnvironmentsTab({
  rpc,
  project,
  environments,
  onChanged,
}: {
  rpc: RPC;
  project: ProjectDetail;
  environments: Environment[];
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    environments[0]?.id ?? null,
  );
  const selected = environments.find((e) => e.id === selectedId) ?? null;
  const [draftName, setDraftName] = useState("");
  const [creating, setCreating] = useState(false);

  // If list changes externally, fall back to first env
  useEffect(() => {
    if (!selectedId && environments.length > 0) {
      setSelectedId(environments[0]!.id);
    }
    if (selectedId && !environments.find((e) => e.id === selectedId)) {
      setSelectedId(environments[0]?.id ?? null);
    }
  }, [environments, selectedId]);

  const submitNewEnv = async () => {
    const name = draftName.trim();
    if (!name) {
      setCreating(false);
      setDraftName("");
      return;
    }
    const created = await rpc.request.createEnvironment({
      projectId: project.id,
      name,
    });
    setDraftName("");
    setCreating(false);
    onChanged();
    if (created.id) setSelectedId(created.id);
  };

  return (
    <div className={s.envLayout}>
      <div className={s.envList}>
        {environments.map((env) => (
          <button
            key={env.id}
            className={clsx(s.envItem, env.id === selectedId && s.envItemActive)}
            onClick={() => setSelectedId(env.id)}
          >
            {env.name}
          </button>
        ))}
        {creating ? (
          <input
            autoFocus
            className={s.input}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={submitNewEnv}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewEnv();
              if (e.key === "Escape") {
                setDraftName("");
                setCreating(false);
              }
            }}
            placeholder="environment name"
          />
        ) : (
          <button className={s.addEnvBtn} onClick={() => setCreating(true)}>
            + new environment
          </button>
        )}
      </div>

      <div className={s.envEditor}>
        {selected ? (
          <EnvironmentEditor
            key={selected.id}
            rpc={rpc}
            env={selected}
            onChanged={onChanged}
          />
        ) : (
          <div className={s.subtleHint}>
            Create an environment to manage its variables.
          </div>
        )}
      </div>
    </div>
  );
}

function EnvironmentEditor({
  rpc,
  env,
  onChanged,
}: {
  rpc: RPC;
  env: Environment;
  onChanged: () => void;
}) {
  const [name, setName] = useState(env.name);
  const [baseUrl, setBaseUrl] = useState(env.baseUrl);
  const [headers, setHeaders] = useState<HeaderEntry[]>(env.headers);
  const [vars, setVars] = useState<EnvVar[]>(env.vars);
  const [auth, setAuth] = useState<AuthConfig>(env.auth);
  const [saving, setSaving] = useState(false);
  const [fetchingToken, setFetchingToken] = useState(false);
  // Two-click delete confirmation. window.confirm() in Tauri's WKWebView
  // is unreliable — sometimes returns undefined silently, which blocks
  // the delete. Inline state is bulletproof.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setName(env.name);
    setBaseUrl(env.baseUrl);
    setHeaders(env.headers);
    setVars(env.vars);
    setAuth(env.auth);
    setConfirmingDelete(false);
  }, [env]);

  const save = async () => {
    setSaving(true);
    await rpc.request.updateEnvironment({ id: env.id, name, vars, baseUrl, headers, auth });
    setSaving(false);
    onChanged();
  };

  const updateAuth = (patch: Partial<AuthConfig>) =>
    setAuth((prev) => ({ ...prev, ...patch }));

  const fetchOAuth2Token = async () => {
    setFetchingToken(true);
    const result = await rpc.request.oauth2FetchToken({
      tokenUrl: auth.oauth2TokenUrl,
      clientId: auth.oauth2ClientId,
      clientSecret: auth.oauth2ClientSecret,
      scopes: auth.oauth2Scopes,
    });
    if (result) {
      updateAuth({
        oauth2AccessToken: result.accessToken,
        oauth2ExpiresAt: result.expiresAt,
      });
    }
    setFetchingToken(false);
  };

  const remove = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      // Auto-revert after 4 seconds if user doesn't click again
      setTimeout(() => setConfirmingDelete(false), 4000);
      return;
    }
    try {
      await rpc.request.deleteEnvironment({ id: env.id });
      onChanged();
    } catch (err) {
      console.error("[deleteEnvironment]", err);
    }
  };

  const addVar = () =>
    setVars([...vars, { key: "", value: "", secret: false }]);
  const removeVar = (idx: number) => setVars(vars.filter((_, i) => i !== idx));
  const updateVar = (idx: number, patch: Partial<EnvVar>) =>
    setVars(vars.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  const addHeader = () =>
    setHeaders([...headers, { key: "", value: "", enabled: true }]);
  const removeHeader = (idx: number) =>
    setHeaders(headers.filter((_, i) => i !== idx));
  const updateHeader = (idx: number, patch: Partial<HeaderEntry>) =>
    setHeaders(headers.map((h, i) => (i === idx ? { ...h, ...patch } : h)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Environment Name</label>
        <input
          className={s.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.label}>Base URL</label>
        <input
          className={s.input}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.dev.example.com"
          spellCheck={false}
        />
        <div className={s.hint}>
          Prepended to relative request URLs (those that don't start with{" "}
          <code>http://</code> or <code>https://</code>).
        </div>
      </div>

      {/* ── Auth ──────────────────────────────────── */}
      <div className={s.field}>
        <label className={s.label}>Authentication</label>
        <select
          className={s.input}
          value={auth.authType}
          onChange={(e) => updateAuth({ authType: e.target.value as AuthType })}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="apiKey">API Key</option>
          <option value="oauth2_client_credentials">OAuth2 Client Credentials</option>
        </select>
      </div>

      {auth.authType === "bearer" && (
        <div className={s.field}>
          <label className={s.label}>Token</label>
          <input
            className={s.input}
            value={auth.bearerToken}
            onChange={(e) => updateAuth({ bearerToken: e.target.value })}
            placeholder="sk-..."
            spellCheck={false}
          />
        </div>
      )}

      {auth.authType === "basic" && (
        <>
          <div className={s.field}>
            <label className={s.label}>Username</label>
            <input
              className={s.input}
              value={auth.basicUsername}
              onChange={(e) => updateAuth({ basicUsername: e.target.value })}
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Password</label>
            <input
              className={s.input}
              type="password"
              value={auth.basicPassword}
              onChange={(e) => updateAuth({ basicPassword: e.target.value })}
            />
          </div>
        </>
      )}

      {auth.authType === "apiKey" && (
        <>
          <div className={s.field}>
            <label className={s.label}>Key Name</label>
            <input
              className={s.input}
              value={auth.apiKeyName}
              onChange={(e) => updateAuth({ apiKeyName: e.target.value })}
              placeholder="X-API-Key"
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Key Value</label>
            <input
              className={s.input}
              value={auth.apiKeyValue}
              onChange={(e) => updateAuth({ apiKeyValue: e.target.value })}
              placeholder="abc123..."
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Send In</label>
            <select
              className={s.input}
              value={auth.apiKeyLocation}
              onChange={(e) =>
                updateAuth({ apiKeyLocation: e.target.value as "header" | "query" })
              }
            >
              <option value="header">Header</option>
              <option value="query">Query Parameter</option>
            </select>
          </div>
        </>
      )}

      {auth.authType === "oauth2_client_credentials" && (
        <>
          <div className={s.field}>
            <label className={s.label}>Token URL</label>
            <input
              className={s.input}
              value={auth.oauth2TokenUrl}
              onChange={(e) => updateAuth({ oauth2TokenUrl: e.target.value })}
              placeholder="https://auth.example.com/oauth/token"
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Client ID</label>
            <input
              className={s.input}
              value={auth.oauth2ClientId}
              onChange={(e) => updateAuth({ oauth2ClientId: e.target.value })}
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Client Secret</label>
            <input
              className={s.input}
              type="password"
              value={auth.oauth2ClientSecret}
              onChange={(e) => updateAuth({ oauth2ClientSecret: e.target.value })}
            />
          </div>
          <div className={s.field}>
            <label className={s.label}>Scopes</label>
            <input
              className={s.input}
              value={auth.oauth2Scopes}
              onChange={(e) => updateAuth({ oauth2Scopes: e.target.value })}
              placeholder="read write"
              spellCheck={false}
            />
          </div>
          <div className={s.field}>
            <button
              className={s.primaryBtn}
              onClick={fetchOAuth2Token}
              disabled={fetchingToken || !auth.oauth2TokenUrl || !auth.oauth2ClientId}
            >
              {fetchingToken ? "Fetching…" : "Fetch Token"}
            </button>
            {auth.oauth2AccessToken && (
              <div className={s.hint} style={{ color: "#6ee7b7" }}>
                ✓ Token cached
                {auth.oauth2ExpiresAt > 0 &&
                  ` · expires ${new Date(auth.oauth2ExpiresAt * 1000).toLocaleTimeString()}`}
              </div>
            )}
          </div>
        </>
      )}

      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Headers</label>
          <button className={s.smallBtn} onClick={addHeader}>
            + add
          </button>
        </div>
        {headers.length === 0 && (
          <div className={s.subtleHint}>
            No env-specific headers. Project defaults apply.
          </div>
        )}
        {headers.map((h, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={h.key}
              onChange={(e) => updateHeader(i, { key: e.target.value })}
              placeholder="key"
              spellCheck={false}
            />
            <input
              className={s.input}
              value={h.value}
              onChange={(e) => updateHeader(i, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
            />
            <button className={s.removeBtn} onClick={() => removeHeader(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.hint}>
          Override project defaults for this environment. Authorization /
          API-key headers usually live here, not at the project level.
        </div>
      </div>

      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Variables</label>
          <button className={s.smallBtn} onClick={addVar}>
            + add
          </button>
        </div>
        {vars.length === 0 && (
          <div className={s.subtleHint}>No variables yet.</div>
        )}
        {vars.map((v, i) => (
          <div className={s.headerRow} key={i}>
            <input
              className={s.input}
              value={v.key}
              onChange={(e) => updateVar(i, { key: e.target.value })}
              placeholder="KEY"
              spellCheck={false}
            />
            <input
              className={s.input}
              value={v.value}
              onChange={(e) => updateVar(i, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
            />
            <button className={s.removeBtn} onClick={() => removeVar(i)}>
              ×
            </button>
          </div>
        ))}
        <div className={s.hint}>
          Use these by dropping an <strong>EnvVar</strong> node on the canvas
          (toolbar → + Env Var) and wiring its output to a node's input pin.
        </div>
      </div>

      <div className={s.actions}>
        <button className={s.dangerBtn} onClick={remove}>
          {confirmingDelete ? "Click again to confirm" : "Delete"}
        </button>
        <button className={s.primaryBtn} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
