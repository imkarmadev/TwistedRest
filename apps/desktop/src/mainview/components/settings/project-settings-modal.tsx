/**
 * Project Settings modal — file-based project model.
 *
 * Lists environments (from .env.json files in the project directory) and
 * opens an editor for their key/value vars.
 * All mutations go through Tauri invoke commands.
 */

import { useEffect, useState } from "react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import s from "./project-settings-modal.module.css";

interface EnvVar {
  key: string;
  value: string;
}

interface ProjectEnvironment {
  name: string;
  filename: string;
  vars: EnvVar[];
}

interface ProjectSettingsModalProps {
  projectPath: string;
  projectName: string | null;
  environments: ProjectEnvironment[];
  onClose: () => void;
  /** Called after any mutation so the parent can reload environments. */
  onChanged: () => void;
}

export function ProjectSettingsModal({
  projectPath,
  projectName,
  environments,
  onClose,
  onChanged,
}: ProjectSettingsModalProps) {
  const [selectedFilename, setSelectedFilename] = useState<string | null>(
    environments[0]?.filename ?? null,
  );
  const [creatingName, setCreatingName] = useState("");
  const [creating, setCreating] = useState(false);

  // If selected env disappears (deleted), fall back to first
  useEffect(() => {
    if (selectedFilename && !environments.find((e) => e.filename === selectedFilename)) {
      setSelectedFilename(environments[0]?.filename ?? null);
    } else if (!selectedFilename && environments.length > 0) {
      setSelectedFilename(environments[0]!.filename);
    }
  }, [environments, selectedFilename]);

  const selected = environments.find((e) => e.filename === selectedFilename) ?? null;

  const submitNewEnv = async () => {
    const name = creatingName.trim();
    setCreatingName("");
    setCreating(false);
    if (!name) return;
    try {
      const created = await invoke<ProjectEnvironment>("create_environment", {
        projectPath,
        envName: name,
      });
      onChanged();
      setSelectedFilename(created.filename);
    } catch (err) {
      console.error("[create_environment]", err);
    }
  };

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <span className={s.title}>Project Settings</span>
          <button className={s.closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        <div className={s.body}>
          <div className={s.envLayout}>
            {/* ── Left: project info + env list ── */}
            <div className={s.envList}>
              <div className={s.projectName}>{projectName ?? "Untitled project"}</div>
              <div className={s.envListLabel}>Environments</div>

              {environments.map((env) => (
                <button
                  key={env.filename}
                  className={clsx(s.envItem, env.filename === selectedFilename && s.envItemActive)}
                  onClick={() => setSelectedFilename(env.filename)}
                >
                  {env.name}
                </button>
              ))}

              {creating ? (
                <input
                  autoFocus
                  className={s.input}
                  value={creatingName}
                  onChange={(e) => setCreatingName(e.target.value)}
                  onBlur={() => void submitNewEnv()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitNewEnv();
                    if (e.key === "Escape") {
                      setCreatingName("");
                      setCreating(false);
                    }
                  }}
                  placeholder="environment name"
                />
              ) : (
                <button className={s.addEnvBtn} onClick={() => setCreating(true)}>
                  + New Environment
                </button>
              )}
            </div>

            {/* ── Right: selected env editor ── */}
            <div className={s.envEditor}>
              {selected ? (
                <EnvironmentEditor
                  key={selected.filename}
                  projectPath={projectPath}
                  env={selected}
                  onChanged={onChanged}
                  onDeleted={() => {
                    onChanged();
                    setSelectedFilename(null);
                  }}
                />
              ) : (
                <div className={s.subtleHint}>
                  Create or select an environment to manage its variables.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Environment editor ─────────────────────────────────────────

function EnvironmentEditor({
  projectPath,
  env,
  onChanged,
  onDeleted,
}: {
  projectPath: string;
  env: ProjectEnvironment;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [vars, setVars] = useState<EnvVar[]>(env.vars);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Sync when the selected env changes
  useEffect(() => {
    setVars(env.vars);
    setConfirmingDelete(false);
  }, [env]);

  const save = async () => {
    setSaving(true);
    try {
      await invoke("save_environment", {
        projectPath,
        envName: env.name,
        vars,
      });
      onChanged();
    } catch (err) {
      console.error("[save_environment]", err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 4000);
      return;
    }
    try {
      await invoke("delete_environment", {
        projectPath,
        envName: env.name,
      });
      onDeleted();
    } catch (err) {
      console.error("[delete_environment]", err);
    }
  };

  const addVar = () => setVars([...vars, { key: "", value: "" }]);
  const removeVar = (idx: number) => setVars(vars.filter((_, i) => i !== idx));
  const updateVar = (idx: number, patch: Partial<EnvVar>) =>
    setVars(vars.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  return (
    <div className={s.form}>
      <div className={s.field}>
        <label className={s.label}>Environment Name</label>
        <div className={s.input} style={{ opacity: 0.6, cursor: "default" }}>
          {env.name}
        </div>
        <div className={s.hint}>Name is set by the filename and cannot be changed here.</div>
      </div>

      <div className={s.field}>
        <div className={s.labelRow}>
          <label className={s.label}>Variables</label>
          <button className={s.smallBtn} onClick={addVar}>
            + Add Variable
          </button>
        </div>
        {vars.length === 0 && (
          <div className={s.subtleHint}>No variables yet. Add one below.</div>
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
      </div>

      <div className={s.actions}>
        <button className={s.dangerBtn} onClick={() => void remove()}>
          {confirmingDelete ? "Click again to confirm" : "Delete Environment"}
        </button>
        <button className={s.primaryBtn} onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
