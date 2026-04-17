/**
 * Root layout — title bar, sidebar (project + flow tree), canvas, inspector.
 *
 * Selection model:
 *   - The canvas owns the React Flow node list.
 *   - When the user selects a node, the canvas calls onSelectionChange so
 *     App can pass it to the Inspector.
 *   - When the inspector edits a node, it calls back into the canvas via the
 *     `updateNodeData` function the canvas registers with us on mount.
 *
 * This split keeps the canvas as the single source of truth for nodes/edges
 * while letting the inspector live outside React Flow's tree.
 *
 * Project model (file-based):
 *   - A project is a directory on disk containing twistedflow.toml and
 *     one or more *.flow.json files.
 *   - `activeProjectPath` is the absolute path to that directory.
 *   - Flows are identified by filename (e.g. "main.flow.json").
 *   - Environments are loaded from the project directory via list_environments.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { TitleBar } from "./components/layout/title-bar";
import { Sidebar } from "./components/layout/sidebar";
import { FlowCanvas } from "./components/canvas/flow-canvas";
import { InspectorPanel } from "./components/inspector/inspector-panel";
import { ProjectSettingsModal } from "./components/settings/project-settings-modal";
import type { DataType } from "@twistedflow/core";
import type { FlowVariable } from "./lib/variables-context";
import { ConsoleContext, type ConsoleEntry } from "./lib/console-context";
import { ConsolePanel } from "./components/console/console-panel";
import { checkForUpdate } from "./lib/update-checker";
import s from "./App.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnvVarEntry {
  key: string;
  value: string;
}

export interface ProjectEnvironment {
  name: string;
  filename: string;
  vars: EnvVarEntry[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  // ── Project ──────────────────────────────────────────────────────
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  // ── Flows ────────────────────────────────────────────────────────
  const [activeFlowFilename, setActiveFlowFilename] = useState<string | null>(null);

  // ── Environments ─────────────────────────────────────────────────
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);

  // ── Node selection ───────────────────────────────────────────────
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // ── Settings modal ───────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Update checker ───────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<{
    latestVersion: string;
    releaseUrl: string;
  } | null>(null);

  useEffect(() => {
    void checkForUpdate().then((info) => {
      if (info) setUpdateInfo(info);
    });
  }, []);

  // ── Running flows (survives flow switching) ───────────────────────
  const [runningFlows, setRunningFlows] = useState<Set<string>>(new Set());

  useEffect(() => {
    let unStarted: UnlistenFn | null = null;
    let unFinished: UnlistenFn | null = null;

    void (async () => {
      unStarted = await listen<{ flowId: string }>("flow:started", (e) => {
        setRunningFlows((prev) => new Set(prev).add(e.payload.flowId));
      });
      unFinished = await listen<{ flowId: string }>("flow:finished", (e) => {
        setRunningFlows((prev) => {
          const next = new Set(prev);
          next.delete(e.payload.flowId);
          return next;
        });
      });
    })();

    return () => {
      unStarted?.();
      unFinished?.();
    };
  }, []);

  // ── Flow variables (scoped to the active flow) ─────────────────────
  const [flowVariables, setFlowVariables] = useState<FlowVariable[]>([]);

  const registerVariables = useCallback(
    (vars: FlowVariable[]) => setFlowVariables(vars),
    [],
  );

  // ── Last-run results / errors / raw responses ─────────────────────
  const [lastResults, setLastResults] = useState<Record<string, Record<string, unknown>>>({});
  const [lastErrors, setLastErrors] = useState<Record<string, string>>({});
  const [lastRawResponses, setLastRawResponses] = useState<Record<string, unknown>>({});

  const registerResults = useCallback(
    (r: Record<string, Record<string, unknown>>) => setLastResults(r),
    [],
  );
  const registerErrors = useCallback(
    (e: Record<string, string>) => setLastErrors(e),
    [],
  );
  const registerRawResponses = useCallback(
    (r: Record<string, unknown>) => setLastRawResponses(r),
    [],
  );

  // ── Console panel ─────────────────────────────────────────────────
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const consoleAppend = useCallback(
    (entry: Omit<ConsoleEntry, "id" | "timestamp">) => {
      setConsoleEntries((prev) => [
        ...prev,
        { id: crypto.randomUUID(), timestamp: Date.now(), ...entry },
      ]);
    },
    [],
  );
  const consoleClear = useCallback(() => setConsoleEntries([]), []);
  const consoleToggle = useCallback(() => setConsoleOpen((v) => !v), []);
  const consoleOpenFn = useCallback(() => setConsoleOpen(true), []);
  const consoleCloseFn = useCallback(() => setConsoleOpen(false), []);

  const consoleContextValue = useMemo(
    () => ({
      entries: consoleEntries,
      isOpen: consoleOpen,
      toggle: consoleToggle,
      open: consoleOpenFn,
      close: consoleCloseFn,
      clear: consoleClear,
      append: consoleAppend,
    }),
    [
      consoleEntries,
      consoleOpen,
      consoleToggle,
      consoleOpenFn,
      consoleCloseFn,
      consoleClear,
      consoleAppend,
    ],
  );

  const handleLog = useCallback(
    (entry: { nodeId: string; label: string; value: unknown }) => {
      consoleAppend(entry);
    },
    [consoleAppend],
  );

  // ── Canvas imperative handles ─────────────────────────────────────
  const updateNodeDataRef = useRef<(id: string, data: Record<string, unknown>) => void>(() => {});
  const deleteNodeRef = useRef<(id: string) => void>(() => {});
  const getInputTypeRef = useRef<(nodeId: string, inputPinId: string) => DataType>(
    () => "unknown",
  );
  const setVariablesRef = useRef<(vars: FlowVariable[]) => void>(() => {});

  const registerUpdateNodeData = useCallback(
    (fn: (id: string, data: Record<string, unknown>) => void) => {
      updateNodeDataRef.current = fn;
    },
    [],
  );
  const registerDeleteNode = useCallback((fn: (id: string) => void) => {
    deleteNodeRef.current = fn;
  }, []);
  const registerGetInputType = useCallback(
    (fn: (nodeId: string, inputPinId: string) => DataType) => {
      getInputTypeRef.current = fn;
    },
    [],
  );
  const registerSetVariables = useCallback(
    (fn: (vars: FlowVariable[]) => void) => {
      setVariablesRef.current = fn;
    },
    [],
  );

  // Stable wrapper — identity never changes, so Inspector won't re-render.
  const getInputType = useCallback(
    (nodeId: string, inputPinId: string) => getInputTypeRef.current(nodeId, inputPinId),
    [],
  );

  // ── Load environments for the active project ──────────────────────
  const loadEnvironments = useCallback(async (projectPath: string) => {
    try {
      const envs = await invoke<ProjectEnvironment[]>("list_environments", { projectPath });
      setEnvironments(envs);
    } catch (err) {
      console.error("[invoke list_environments]", err);
      setEnvironments([]);
    }
  }, []);

  // ── React to project path change ──────────────────────────────────
  useEffect(() => {
    if (!activeProjectPath) {
      setProjectName(null);
      setEnvironments([]);
      setActiveFlowFilename(null);
      setSelectedNode(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      // Load project metadata (name from twistedflow.toml)
      try {
        const meta = await invoke<{ path: string; name: string }>("open_project", {
          path: activeProjectPath,
        });
        if (!cancelled) {
          setProjectName(meta.name);
          // Update path if backend expanded ~ to absolute (won't re-trigger
          // effect if the value is the same)
          if (meta.path !== activeProjectPath) {
            setActiveProjectPath(meta.path);
            return; // effect will re-run with the canonical path
          }
        }
      } catch (err) {
        console.error("[invoke open_project]", err);
        if (!cancelled) setProjectName(null);
      }

      // Load environments
      if (!cancelled) {
        await loadEnvironments(activeProjectPath);
      }

      // Load flow list and auto-select the first flow
      if (!cancelled) {
        try {
          const flows = await invoke<{ filename: string; name: string }[]>("list_flows", {
            projectPath: activeProjectPath,
          });
          if (!cancelled) {
            setActiveFlowFilename(flows[0]?.filename ?? null);
          }
        } catch (err) {
          console.error("[invoke list_flows]", err);
          if (!cancelled) setActiveFlowFilename(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, loadEnvironments]);

  // Drop node selection and reset variables when the active flow changes
  useEffect(() => {
    setSelectedNode(null);
    setFlowVariables([]);
  }, [activeFlowFilename]);

  // ── Project open / create handlers (called by Sidebar) ───────────
  const handleOpenProject = useCallback((path: string) => {
    setActiveProjectPath(path);
    setActiveFlowFilename(null);
    setSelectedNode(null);
  }, []);

  // ── Inspector callbacks ───────────────────────────────────────────
  const handleInspectorChange = useCallback(
    (id: string, data: Record<string, unknown>) => {
      updateNodeDataRef.current(id, data);
      setSelectedNode((prev) => (prev && prev.id === id ? { ...prev, data } : prev));
    },
    [],
  );

  const handleInspectorDelete = useCallback((id: string) => {
    deleteNodeRef.current(id);
    setSelectedNode(null);
  }, []);

  /** When the inspector edits variables, update both App state and the canvas. */
  const handleFlowVariablesChange = useCallback(
    (vars: FlowVariable[]) => {
      setFlowVariables(vars);
      setVariablesRef.current(vars);
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────────────
  return (
    <ConsoleContext.Provider value={consoleContextValue}>
      <div className={s.root}>
        {/*
         * No CSS material div here — vibrancy is provided natively by
         * NSVisualEffectView via window-vibrancy in src-tauri/src/lib.rs.
         * The window itself is transparent and macOS draws the material
         * behind everything we paint.
         */}
        <TitleBar />

        {updateInfo && (
          <div className={s.updateBanner}>
            <span>v{updateInfo.latestVersion} available</span>
            <a
              href={updateInfo.releaseUrl}
              target="_blank"
              rel="noopener"
              className={s.updateLink}
            >
              Download
            </a>
            <button
              className={s.updateDismiss}
              onClick={() => setUpdateInfo(null)}
            >
              ×
            </button>
          </div>
        )}

        <div className={s.body}>
          <Sidebar
            activeProjectPath={activeProjectPath}
            activeProjectName={projectName}
            activeFlowFilename={activeFlowFilename}
            runningFlows={runningFlows}
            onOpenProject={handleOpenProject}
            onCreateProject={(parentPath, name) => {
              void invoke("create_project", { parentPath, name }).then(() => {
                handleOpenProject(`${parentPath}/${name}`);
              });
            }}
            onSelectFlow={setActiveFlowFilename}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <main className={s.content}>
            {activeProjectPath && activeFlowFilename ? (
              <FlowCanvas
                projectPath={activeProjectPath}
                flowFilename={activeFlowFilename}
                running={runningFlows.has(activeFlowFilename!)}
                selectedNode={selectedNode}
                onSelectionChange={setSelectedNode}
                registerUpdateNodeData={registerUpdateNodeData}
                registerDeleteNode={registerDeleteNode}
                environments={environments}
                onResultsChange={registerResults}
                onErrorsChange={registerErrors}
                onRawResponsesChange={registerRawResponses}
                registerGetInputType={registerGetInputType}
                onLog={handleLog}
                onVariablesChange={registerVariables}
                registerSetVariables={registerSetVariables}
              />
            ) : (
              <div className={s.empty}>
                <div className={s.emptyTitle}>TwistedFlow</div>
                <div className={s.emptyDesc}>
                  Open or create a project to start building API workflows.
                </div>
              </div>
            )}
          </main>

          {/* Inspector mounts when a node is selected OR when a flow is
              active (to show the Variables Panel on empty-canvas click). */}
          {activeProjectPath && activeFlowFilename && (
            <InspectorPanel
              node={selectedNode}
              onChange={handleInspectorChange}
              onDelete={handleInspectorDelete}
              environments={environments}
              results={lastResults}
              errors={lastErrors}
              rawResponses={lastRawResponses}
              getInputType={getInputType}
              flowVariables={flowVariables}
              onFlowVariablesChange={handleFlowVariablesChange}
            />
          )}
        </div>

        {settingsOpen && activeProjectPath && (
          <ProjectSettingsModal
            projectPath={activeProjectPath}
            projectName={projectName}
            environments={environments}
            onClose={() => setSettingsOpen(false)}
            onChanged={() => {
              void loadEnvironments(activeProjectPath);
            }}
          />
        )}

        {/* Bottom console panel — visible on every flow, persists across switches.
            insetRight reserves space for the inspector island when it's mounted. */}
        {activeProjectPath && activeFlowFilename && (
          <ConsolePanel insetRight={356} />
        )}
      </div>
    </ConsoleContext.Provider>
  );
}
