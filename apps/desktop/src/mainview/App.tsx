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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { TitleBar } from "./components/layout/title-bar";
import { Sidebar } from "./components/layout/sidebar";
import { FlowCanvas } from "./components/canvas/flow-canvas";
import { InspectorPanel } from "./components/inspector/inspector-panel";
import { ProjectSettingsModal } from "./components/settings/project-settings-modal";
import { useTauri, type ProjectDetail, type Environment } from "./use-tauri";
import type { DataType } from "@twistedrest/core";
import { ConsoleContext, type ConsoleEntry } from "./lib/console-context";
import { ConsolePanel } from "./components/console/console-panel";
import s from "./App.module.css";

export interface ProjectItem {
  id: string;
  name: string;
  updatedAt: string;
}

export default function App() {
  const { rpc } = useTauri();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // Project metadata + environments are loaded once per active project
  // and passed down so the canvas + Start node can use them at run time.
  const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Last-run results + errors + raw responses, surfaced to the inspector.
  // FlowCanvas pushes these up via the callbacks below so the (out-of-tree)
  // Inspector can display them when a node is selected.
  const [lastResults, setLastResults] = useState<Record<string, Record<string, unknown>>>({});
  const [lastErrors, setLastErrors] = useState<Record<string, string>>({});
  const [lastRawResponses, setLastRawResponses] = useState<Record<string, unknown>>({});
  const registerResults = useCallback(
    (r: Record<string, Record<string, unknown>>) => {
      setLastResults(r);
    },
    [],
  );
  const registerErrors = useCallback((e: Record<string, string>) => {
    setLastErrors(e);
  }, []);
  const registerRawResponses = useCallback((r: Record<string, unknown>) => {
    setLastRawResponses(r);
  }, []);

  // ── Console panel state ──────────────────────────────────────
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

  // Pass-through callback the executor invokes when a Log node fires.
  const handleLog = useCallback(
    (entry: { nodeId: string; label: string; value: unknown }) => {
      consoleAppend(entry);
    },
    [consoleAppend],
  );

  const refreshProjectMeta = useCallback(async () => {
    if (!rpc || !activeProjectId) {
      setActiveProject(null);
      setEnvironments([]);
      return;
    }
    const [proj, envs] = await Promise.all([
      rpc.request.getProject({ id: activeProjectId }),
      rpc.request.listEnvironments({ projectId: activeProjectId }),
    ]);
    setActiveProject(proj);
    setEnvironments(envs);
  }, [rpc, activeProjectId]);

  useEffect(() => {
    void refreshProjectMeta();
  }, [refreshProjectMeta]);

  // Canvas-owned imperative handles. Stored in refs so re-renders don't
  // detach the inspector from the canvas.
  const updateNodeDataRef = useRef<(id: string, data: Record<string, unknown>) => void>(() => {});
  const deleteNodeRef = useRef<(id: string) => void>(() => {});
  const getInputTypeRef = useRef<(nodeId: string, inputPinId: string) => DataType>(
    () => "unknown",
  );

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

  // Stable wrapper passed to the Inspector — forwards to the latest closure
  // captured by FlowCanvas. Doesn't change identity so the Inspector won't
  // re-render unnecessarily.
  const getInputType = useCallback(
    (nodeId: string, inputPinId: string) => getInputTypeRef.current(nodeId, inputPinId),
    [],
  );

  // Initial project load
  useEffect(() => {
    if (!rpc) return;
    void rpc.request.listProjects({}).then(setProjects);
  }, [rpc]);

  // When the active project changes, ensure it has at least one flow and select it.
  useEffect(() => {
    if (!rpc || !activeProjectId) {
      setActiveFlowId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      let list = await rpc.request.listFlows({ projectId: activeProjectId });
      if (cancelled) return;
      if (list.length === 0) {
        const created = await rpc.request.createFlow({ projectId: activeProjectId, name: "main" });
        if (cancelled || !created.id) return;
        list = await rpc.request.listFlows({ projectId: activeProjectId });
      }
      if (cancelled) return;
      setActiveFlowId(list[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, activeProjectId]);

  // Drop selection when the active flow changes
  useEffect(() => {
    setSelectedNode(null);
  }, [activeFlowId]);

  const handleCreateProject = useCallback(
    async (name: string) => {
      if (!rpc) return;
      const created = await rpc.request.createProject({ name });
      if (!created.id) return;
      const fresh = await rpc.request.listProjects({});
      setProjects(fresh);
      setActiveProjectId(created.id);
    },
    [rpc],
  );

  const handleSelectProject = useCallback((id: string) => {
    setActiveProjectId(id);
    setActiveFlowId(null);
    setSelectedNode(null);
  }, []);

  const handleInspectorChange = useCallback(
    (id: string, data: Record<string, unknown>) => {
      updateNodeDataRef.current(id, data);
      // Keep the local selectedNode reference in sync so the inspector
      // re-renders against the latest data.
      setSelectedNode((prev) => (prev && prev.id === id ? { ...prev, data } : prev));
    },
    [],
  );

  const handleInspectorDelete = useCallback((id: string) => {
    deleteNodeRef.current(id);
    setSelectedNode(null);
  }, []);

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

      <div className={s.body}>
        <Sidebar
          rpc={rpc}
          projects={projects}
          activeProjectId={activeProjectId}
          activeFlowId={activeFlowId}
          onSelectProject={handleSelectProject}
          onSelectFlow={setActiveFlowId}
          onCreateProject={handleCreateProject}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className={s.content}>
          {rpc && activeFlowId ? (
            <FlowCanvas
              rpc={rpc}
              flowId={activeFlowId}
              selectedNode={selectedNode}
              onSelectionChange={setSelectedNode}
              registerUpdateNodeData={registerUpdateNodeData}
              registerDeleteNode={registerDeleteNode}
              project={activeProject}
              environments={environments}
              onResultsChange={registerResults}
              onErrorsChange={registerErrors}
              onRawResponsesChange={registerRawResponses}
              registerGetInputType={registerGetInputType}
              onLog={handleLog}
            />
          ) : (
            <div className={s.empty}>
              <div className={s.emptyTitle}>TwistedRest</div>
              <div className={s.emptyDesc}>
                {projects.length === 0
                  ? "Create a project to start building API workflows."
                  : "Select a project to open its canvas."}
              </div>
            </div>
          )}
        </main>

        {/* Inspector only mounts when something is selected — empty panel
            wastes ~340px of canvas real estate. */}
        {rpc && activeFlowId && selectedNode && (
          <InspectorPanel
            node={selectedNode}
            onChange={handleInspectorChange}
            onDelete={handleInspectorDelete}
            environments={environments}
            results={lastResults}
            errors={lastErrors}
            rawResponses={lastRawResponses}
            getInputType={getInputType}
          />
        )}
      </div>

      {settingsOpen && rpc && activeProject && (
        <ProjectSettingsModal
          rpc={rpc}
          project={activeProject}
          environments={environments}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            void refreshProjectMeta();
            // Also refresh the sidebar's project list so a renamed project
            // shows the new name immediately without a manual reload.
            void rpc!.request.listProjects({}).then(setProjects);
          }}
        />
      )}

      {/* Bottom console panel — visible on every flow, persists across switches.
          insetRight reserves space for the inspector island when it's mounted. */}
      {rpc && activeFlowId && (
        <ConsolePanel insetRight={selectedNode ? 356 : 16} />
      )}
    </div>
    </ConsoleContext.Provider>
  );
}
