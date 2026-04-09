import { useEffect, useState } from "react";
import clsx from "clsx";
import type { ProjectItem } from "../../App";
import type { RPC } from "../../use-tauri";
import s from "./sidebar.module.css";

interface FlowItem {
  id: string;
  name: string;
}

interface SidebarProps {
  rpc: RPC | null;
  projects: ProjectItem[];
  activeProjectId: string | null;
  activeFlowId: string | null;
  onSelectProject: (id: string) => void;
  onSelectFlow: (flowId: string) => void;
  onCreateProject: (name: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  rpc,
  projects,
  activeProjectId,
  activeFlowId,
  onSelectProject,
  onSelectFlow,
  onCreateProject,
  onOpenSettings,
}: SidebarProps) {
  const [flowsByProject, setFlowsByProject] = useState<Record<string, FlowItem[]>>({});
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingFlowFor, setCreatingFlowFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Refetch flows when the active project changes OR when the active flow
  // changes (which happens after App auto-creates the "main" flow for a
  // newly-created project — without this dep, the sidebar's fetch races
  // App's create and shows an empty list).
  useEffect(() => {
    if (!rpc || !activeProjectId) return;
    void rpc.request.listFlows({ projectId: activeProjectId }).then((list) => {
      setFlowsByProject((prev) => ({ ...prev, [activeProjectId]: list }));
    });
  }, [rpc, activeProjectId, activeFlowId]);

  const submitProject = () => {
    const name = draft.trim();
    if (!name) {
      setCreatingProject(false);
      return;
    }
    onCreateProject(name);
    setDraft("");
    setCreatingProject(false);
  };

  const submitFlow = async () => {
    const name = draft.trim();
    if (!name || !rpc || !creatingFlowFor) {
      setCreatingFlowFor(null);
      setDraft("");
      return;
    }
    const created = await rpc.request.createFlow({ projectId: creatingFlowFor, name });
    if (created.id) {
      const list = await rpc.request.listFlows({ projectId: creatingFlowFor });
      setFlowsByProject((prev) => ({ ...prev, [creatingFlowFor]: list }));
      onSelectFlow(created.id);
    }
    setDraft("");
    setCreatingFlowFor(null);
  };

  return (
    <aside className={s.sidebar}>
      {/* Drag region behind the OS traffic lights — empty so all clicks
          fall through to Tauri's window drag handler. */}
      <div data-tauri-drag-region className={s.dragHandle} />

      <div className={s.header}>
        <span className={s.headerLabel}>Projects</span>
        <button
          className={s.addBtn}
          onClick={() => setCreatingProject(true)}
          aria-label="New project"
        >
          +
        </button>
      </div>

      <div className={s.list}>
        {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          const flows = flowsByProject[p.id] ?? [];
          return (
            <div key={p.id} className={s.projectGroup}>
              <button
                className={clsx(s.projectItem, isActive && s.projectItemActive)}
                onClick={() => onSelectProject(p.id)}
              >
                <span className={s.chevron}>{isActive ? "▾" : "▸"}</span>
                <span className={s.projectName}>{p.name}</span>
                {isActive && (
                  <span
                    className={s.gear}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenSettings();
                    }}
                    title="Project settings"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </span>
                )}
              </button>

              {isActive && (
                <div className={s.flowList}>
                  {flows.map((f) => (
                    <button
                      key={f.id}
                      className={clsx(s.flowItem, f.id === activeFlowId && s.flowItemActive)}
                      onClick={() => onSelectFlow(f.id)}
                    >
                      {f.name}
                    </button>
                  ))}

                  {creatingFlowFor === p.id ? (
                    <input
                      autoFocus
                      className={s.input}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={submitFlow}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitFlow();
                        if (e.key === "Escape") {
                          setDraft("");
                          setCreatingFlowFor(null);
                        }
                      }}
                      placeholder="Flow name"
                    />
                  ) : (
                    <button
                      className={s.addFlow}
                      onClick={() => {
                        setCreatingFlowFor(p.id);
                        setDraft("");
                      }}
                    >
                      + new flow
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {creatingProject && (
          <input
            autoFocus
            className={s.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitProject}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitProject();
              if (e.key === "Escape") {
                setDraft("");
                setCreatingProject(false);
              }
            }}
            placeholder="Project name"
          />
        )}

        {!creatingProject && projects.length === 0 && (
          <div className={s.emptyHint}>No projects yet</div>
        )}
      </div>
    </aside>
  );
}
