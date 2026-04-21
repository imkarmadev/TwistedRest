import { useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import s from "./project-bar.module.css";

interface ProjectBarProps {
  activeProjectPath: string | null;
  activeProjectName: string | null;
  activeFlowFilename: string | null;
  insetRight: number;
  onAddNode: () => void;
  onBuildFlow: () => void;
  onOpenProject: (path: string) => void;
  onCreateProject: (parentPath: string, name: string) => void;
  onOpenSettings: () => void;
}

export function ProjectBar({
  activeProjectPath,
  activeProjectName,
  activeFlowFilename,
  insetRight,
  onAddNode,
  onBuildFlow,
  onOpenProject,
  onCreateProject,
  onOpenSettings,
}: ProjectBarProps) {
  const [showCreateName, setShowCreateName] = useState(false);
  const [createParentPath, setCreateParentPath] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");

  const handleOpenProject = async () => {
    const selected = await pickFolder({ directory: true, title: "Open TwistedFlow Project" });
    if (selected && typeof selected === "string") {
      onOpenProject(selected);
    }
  };

  const handleCreateProject = async () => {
    const selected = await pickFolder({
      directory: true,
      title: "Choose parent folder for new project",
    });
    if (selected && typeof selected === "string") {
      setCreateParentPath(selected);
      setShowCreateName(true);
      setCreateName("");
    }
  };

  const submitCreateProject = () => {
    const parent = createParentPath;
    const name = createName.trim();
    setShowCreateName(false);
    setCreateParentPath(null);
    setCreateName("");
    if (parent && name) {
      onCreateProject(parent, name);
    }
  };

  const flowLabel = activeFlowFilename
    ? activeFlowFilename.replace(/\.flow\.json$/i, "").replace(/\.json$/i, "")
    : null;

  return (
    <>
      <div className={s.shell} style={{ right: insetRight }}>
        <div data-tauri-drag-region className={s.dragStrip} aria-hidden="true" />
        <div className={s.leftGroup}>
          <header className={s.contextBar}>
            <div data-tauri-drag-region className={s.contextDrag}>
              <span className={s.product}>TwistedFlow</span>
              {activeProjectName ? (
                <>
                  <span className={s.separator}>/</span>
                  <span className={s.projectName}>{activeProjectName}</span>
                </>
              ) : (
                <span className={s.hint}>No project open</span>
              )}
              {flowLabel && (
                <>
                  <span className={s.separator}>/</span>
                  <span className={s.flowName}>{flowLabel}</span>
                </>
              )}
            </div>
          </header>

          {activeProjectPath && activeFlowFilename && (
            <div className={s.flowActions}>
              <button
                type="button"
                className={clsx(s.actionBtn, s.actionBtnPrimary)}
                onClick={onAddNode}
              >
                <span className={s.btnIcon}>+</span>
                <span>Add Node</span>
              </button>
              <button type="button" className={s.actionBtn} onClick={onBuildFlow}>
                Build
              </button>
            </div>
          )}
        </div>

        <div className={s.projectActions}>
          <button type="button" className={s.actionBtn} onClick={handleOpenProject}>
            Open
          </button>
          <button type="button" className={clsx(s.actionBtn, s.actionBtnPrimary)} onClick={handleCreateProject}>
            New Project
          </button>
          {activeProjectPath && (
            <button
              type="button"
              className={s.iconBtn}
              onClick={onOpenSettings}
              title="Settings"
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
            </button>
          )}
        </div>
      </div>

      {showCreateName && (
        <div className={s.createPopover} style={{ right: insetRight }}>
          <div className={s.popoverLabel}>Project name</div>
          <input
            autoFocus
            className={s.popoverInput}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreateProject();
              if (e.key === "Escape") {
                setShowCreateName(false);
                setCreateParentPath(null);
              }
            }}
            placeholder="my-project"
          />
          <div className={s.popoverActions}>
            <button
              type="button"
              className={clsx(s.actionBtn, s.actionBtnPrimary)}
              onClick={submitCreateProject}
            >
              Create
            </button>
            <button
              type="button"
              className={s.actionBtn}
              onClick={() => {
                setShowCreateName(false);
                setCreateParentPath(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
