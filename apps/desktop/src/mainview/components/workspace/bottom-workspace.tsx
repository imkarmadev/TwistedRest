import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConsole } from "../../lib/console-context";
import s from "./bottom-workspace.module.css";

export type BottomWorkspaceTabId =
  | "flows"
  | "subflows"
  | "customNodes"
  | "console"
  | "problems";

interface FlowItem {
  name: string;
  filename: string;
  kind?: string;
}

interface CustomNodeSummary {
  typeId: string;
  name: string;
}

interface CustomNodeAsset {
  id: string;
  name: string;
  wasmPath?: string | null;
  sourcePath?: string | null;
  status: string;
  canUse: boolean;
  canBuild: boolean;
  canOpenSource: boolean;
  nodes: CustomNodeSummary[];
  error?: string | null;
}

interface BottomWorkspaceProps {
  projectPath: string;
  activeFlowFilename: string | null;
  runningFlows: Set<string>;
  activeTab: BottomWorkspaceTabId | null;
  insetRight: number;
  problems: Record<string, string>;
  onTabChange: (tab: BottomWorkspaceTabId | null) => void;
  onNodeCatalogChange: () => void;
  onSelectFlow: (filename: string) => void;
}

const TABS: Array<{ id: BottomWorkspaceTabId; label: string }> = [
  { id: "flows", label: "Flows" },
  { id: "subflows", label: "Subflows" },
  { id: "customNodes", label: "Custom Nodes" },
  { id: "console", label: "Console" },
  { id: "problems", label: "Problems" },
];

export function BottomWorkspace({
  projectPath,
  activeFlowFilename,
  runningFlows,
  activeTab,
  insetRight,
  problems,
  onTabChange,
  onNodeCatalogChange,
  onSelectFlow,
}: BottomWorkspaceProps) {
  const { entries, isOpen: consoleOpen, open: openConsole, close: closeConsole, clear } = useConsole();
  const [flows, setFlows] = useState<FlowItem[]>([]);
  const [customNodes, setCustomNodes] = useState<CustomNodeAsset[]>([]);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [loadingCustomNodes, setLoadingCustomNodes] = useState(false);

  const [flowDraftMode, setFlowDraftMode] = useState<"flow" | "subflow" | null>(null);
  const [flowDraftName, setFlowDraftName] = useState("");
  const [flowDraftError, setFlowDraftError] = useState<string | null>(null);

  const [customNodeDraftOpen, setCustomNodeDraftOpen] = useState(false);
  const [customNodeDraftName, setCustomNodeDraftName] = useState("");
  const [customNodeFeedback, setCustomNodeFeedback] = useState<{
    kind: "ok" | "error";
    message: string;
  } | null>(null);
  const [creatingCustomNode, setCreatingCustomNode] = useState(false);
  const [busyCustomNodeId, setBusyCustomNodeId] = useState<string | null>(null);

  const loadFlows = useCallback(async () => {
    setLoadingFlows(true);
    try {
      const next = await invoke<FlowItem[]>("list_flows", { projectPath });
      setFlows(next);
    } catch (err) {
      console.error("[invoke list_flows]", err);
      setFlows([]);
    } finally {
      setLoadingFlows(false);
    }
  }, [projectPath]);

  const loadCustomNodes = useCallback(async () => {
    setLoadingCustomNodes(true);
    try {
      const next = await invoke<CustomNodeAsset[]>("list_custom_nodes", { projectPath });
      setCustomNodes(next);
    } catch (err) {
      console.error("[invoke list_custom_nodes]", err);
      setCustomNodes([]);
    } finally {
      setLoadingCustomNodes(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void loadFlows();
  }, [loadFlows, activeFlowFilename]);

  useEffect(() => {
    void loadCustomNodes();
  }, [loadCustomNodes]);

  useEffect(() => {
    if (activeTab !== "customNodes") return;
    void loadCustomNodes();
  }, [activeTab, loadCustomNodes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;
      if (e.key !== "`" && e.key !== "~") return;
      e.preventDefault();
      if (consoleOpen) closeConsole();
      else openConsole();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [consoleOpen, openConsole, closeConsole]);

  const mainFlows = useMemo(
    () => flows.filter((flow) => (flow.kind ?? "main") === "main"),
    [flows],
  );
  const subflows = useMemo(
    () => flows.filter((flow) => flow.kind === "subflow"),
    [flows],
  );

  const [unreadConsoleCount, setUnreadConsoleCount] = useState(0);
  const lastReadCountRef = useRef(0);
  useEffect(() => {
    if (activeTab === "console") {
      lastReadCountRef.current = entries.length;
      setUnreadConsoleCount(0);
    } else {
      setUnreadConsoleCount(entries.length - lastReadCountRef.current);
    }
  }, [activeTab, entries.length]);

  const problemEntries = useMemo(
    () => Object.entries(problems).map(([nodeId, error]) => ({ nodeId, error })),
    [problems],
  );

  const tabCounts = useMemo<Record<BottomWorkspaceTabId, number>>(
    () => ({
      flows: mainFlows.length,
      subflows: subflows.length,
      customNodes: customNodes.length,
      console: unreadConsoleCount,
      problems: problemEntries.length,
    }),
    [customNodes.length, mainFlows.length, problemEntries.length, subflows.length, unreadConsoleCount],
  );

  const handleTabClick = useCallback(
    (tab: BottomWorkspaceTabId) => {
      onTabChange(activeTab === tab ? null : tab);
    },
    [activeTab, onTabChange],
  );

  const openFlowDraft = useCallback((mode: "flow" | "subflow") => {
    setFlowDraftMode(mode);
    setFlowDraftName("");
    setFlowDraftError(null);
  }, []);

  const cancelFlowDraft = useCallback(() => {
    setFlowDraftMode(null);
    setFlowDraftName("");
    setFlowDraftError(null);
  }, []);

  const submitFlowDraft = useCallback(async () => {
    if (!flowDraftMode) return;
    const name = flowDraftName.trim();
    if (!name) {
      setFlowDraftError("Name is required.");
      return;
    }

    const command = flowDraftMode === "subflow" ? "create_subflow" : "create_flow";
    try {
      const created = await invoke<{ filename: string }>(command, { projectPath, name });
      await loadFlows();
      onSelectFlow(created.filename);
      if (flowDraftMode === "subflow") {
        onNodeCatalogChange();
      }
      cancelFlowDraft();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFlowDraftError(message);
    }
  }, [
    cancelFlowDraft,
    flowDraftMode,
    flowDraftName,
    loadFlows,
    onNodeCatalogChange,
    onSelectFlow,
    projectPath,
  ]);

  const openCustomNodeDraft = useCallback(() => {
    setCustomNodeDraftOpen(true);
    setCustomNodeDraftName("");
    setCustomNodeFeedback(null);
  }, []);

  const cancelCustomNodeDraft = useCallback(() => {
    setCustomNodeDraftOpen(false);
    setCustomNodeDraftName("");
  }, []);

  const submitCustomNodeDraft = useCallback(async () => {
    const name = customNodeDraftName.trim();
    if (!name) {
      setCustomNodeFeedback({ kind: "error", message: "Custom node name is required." });
      return;
    }

    setCreatingCustomNode(true);
    setCustomNodeFeedback(null);
    try {
      const sourcePath = await invoke<string>("create_custom_node_source", {
        projectPath,
        name,
      });
      await loadCustomNodes();
      setCustomNodeDraftOpen(false);
      setCustomNodeDraftName("");
      setCustomNodeFeedback({ kind: "ok", message: `Created source: ${sourcePath}` });
      await invoke("open_custom_node_source", { sourcePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCustomNodeFeedback({ kind: "error", message });
    } finally {
      setCreatingCustomNode(false);
    }
  }, [customNodeDraftName, loadCustomNodes, projectPath]);

  const handleOpenCustomNodeSource = useCallback(async (sourcePath: string) => {
    try {
      await invoke("open_custom_node_source", { sourcePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCustomNodeFeedback({ kind: "error", message });
    }
  }, []);

  const handleBuildCustomNode = useCallback(
    async (asset: CustomNodeAsset) => {
      if (!asset.sourcePath) return;
      setBusyCustomNodeId(asset.id);
      setCustomNodeFeedback(null);
      try {
        const message = await invoke<string>("build_custom_node", {
          projectPath,
          sourcePath: asset.sourcePath,
        });
        await loadCustomNodes();
        onNodeCatalogChange();
        setCustomNodeFeedback({ kind: "ok", message });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setCustomNodeFeedback({ kind: "error", message });
      } finally {
        setBusyCustomNodeId(null);
      }
    },
    [loadCustomNodes, onNodeCatalogChange, projectPath],
  );

  return (
    <div className={s.workspace} style={{ right: insetRight }}>
      {activeTab && (
        <div className={s.panel}>
          {activeTab === "flows" && (
            <FlowListTab
              title="Flows"
              createLabel="New Flow"
              kind="main"
              projectPath={projectPath}
              draftOpen={flowDraftMode === "flow"}
              draftName={flowDraftName}
              draftError={flowDraftMode === "flow" ? flowDraftError : null}
              items={mainFlows}
              activeFlowFilename={activeFlowFilename}
              runningFlows={runningFlows}
              loading={loadingFlows}
              onCreateRequest={() => openFlowDraft("flow")}
              onDraftCancel={cancelFlowDraft}
              onDraftChange={setFlowDraftName}
              onDraftSubmit={() => {
                void submitFlowDraft();
              }}
              onReload={() => {
                void loadFlows();
              }}
              onNodeCatalogChange={onNodeCatalogChange}
              onSelectFlow={onSelectFlow}
            />
          )}

          {activeTab === "subflows" && (
            <FlowListTab
              title="Subflows"
              createLabel="New Subflow"
              kind="subflow"
              projectPath={projectPath}
              draftOpen={flowDraftMode === "subflow"}
              draftName={flowDraftName}
              draftError={flowDraftMode === "subflow" ? flowDraftError : null}
              items={subflows}
              activeFlowFilename={activeFlowFilename}
              runningFlows={runningFlows}
              loading={loadingFlows}
              onCreateRequest={() => openFlowDraft("subflow")}
              onDraftCancel={cancelFlowDraft}
              onDraftChange={setFlowDraftName}
              onDraftSubmit={() => {
                void submitFlowDraft();
              }}
              onReload={() => {
                void loadFlows();
              }}
              onNodeCatalogChange={onNodeCatalogChange}
              onSelectFlow={onSelectFlow}
            />
          )}

          {activeTab === "customNodes" && (
            <CustomNodesTab
              assets={customNodes}
              loading={loadingCustomNodes}
              busyNodeId={busyCustomNodeId}
              draftOpen={customNodeDraftOpen}
              draftName={customNodeDraftName}
              feedback={customNodeFeedback}
              creating={creatingCustomNode}
              onCreateRequest={openCustomNodeDraft}
              onDraftCancel={cancelCustomNodeDraft}
              onDraftChange={setCustomNodeDraftName}
              onDraftSubmit={() => {
                void submitCustomNodeDraft();
              }}
              onOpenSource={(sourcePath) => {
                void handleOpenCustomNodeSource(sourcePath);
              }}
              onBuild={(asset) => {
                void handleBuildCustomNode(asset);
              }}
              onReload={() => {
                void loadCustomNodes();
              }}
            />
          )}

          {activeTab === "console" && (
            <ConsoleTab entries={entries} onClear={clear} />
          )}

          {activeTab === "problems" && (
            <ProblemsTab problems={problemEntries} />
          )}
        </div>
      )}

      <div className={s.tabBar}>
        {TABS.map((tab) => {
          const count = tabCounts[tab.id];
          const showCount = count > 0;
          return (
            <button
              key={tab.id}
              type="button"
              className={`${s.tab} ${activeTab === tab.id ? s.tabActive : ""}`}
              onClick={() => handleTabClick(tab.id)}
              title={tab.label}
            >
              <span className={s.tabLabel}>{tab.label}</span>
              {showCount && (
                <span className={`${s.tabCount} ${tab.id === "problems" ? s.tabCountDanger : ""}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FlowListTab({
  title,
  createLabel,
  kind,
  projectPath,
  draftOpen,
  draftName,
  draftError,
  items,
  activeFlowFilename,
  runningFlows,
  loading,
  onCreateRequest,
  onDraftCancel,
  onDraftChange,
  onDraftSubmit,
  onReload,
  onNodeCatalogChange,
  onSelectFlow,
}: {
  title: string;
  createLabel: string;
  kind: "main" | "subflow";
  projectPath: string;
  draftOpen: boolean;
  draftName: string;
  draftError: string | null;
  items: FlowItem[];
  activeFlowFilename: string | null;
  runningFlows: Set<string>;
  loading: boolean;
  onCreateRequest: () => void;
  onDraftCancel: () => void;
  onDraftChange: (value: string) => void;
  onDraftSubmit: () => void;
  onReload: () => void;
  onNodeCatalogChange: () => void;
  onSelectFlow: (filename: string) => void;
}) {
  const [renameTarget, setRenameTarget] = useState<FlowItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busyFilename, setBusyFilename] = useState<string | null>(null);
  const [confirmDeleteFilename, setConfirmDeleteFilename] = useState<string | null>(null);

  const startRename = useCallback((item: FlowItem) => {
    setRenameTarget(item);
    setRenameValue(item.name);
    setRenameError(null);
  }, []);

  const cancelRename = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
    setRenameError(null);
  }, []);

  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenameError("Name is required.");
      return;
    }
    setBusyFilename(renameTarget.filename);
    setRenameError(null);
    try {
      const renamed = await invoke<{ filename: string }>("rename_flow", {
        projectPath,
        oldFilename: renameTarget.filename,
        newName: nextName,
      });
      onReload();
      if (kind === "subflow") onNodeCatalogChange();
      if (activeFlowFilename === renameTarget.filename) {
        onSelectFlow(renamed.filename);
      }
      cancelRename();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRenameError(message);
    } finally {
      setBusyFilename(null);
    }
  }, [
    activeFlowFilename,
    cancelRename,
    kind,
    onNodeCatalogChange,
    onReload,
    onSelectFlow,
    projectPath,
    renameTarget,
    renameValue,
  ]);

  const deleteFlow = useCallback(async (item: FlowItem) => {
    setBusyFilename(item.filename);
    try {
      await invoke("delete_flow", { projectPath, filename: item.filename });
      const remaining = items.filter((flow) => flow.filename !== item.filename);
      onReload();
      if (kind === "subflow") onNodeCatalogChange();
      if (activeFlowFilename === item.filename) {
        onSelectFlow(remaining[0]?.filename ?? "");
      }
      setConfirmDeleteFilename(null);
      if (renameTarget?.filename === item.filename) {
        cancelRename();
      }
    } finally {
      setBusyFilename(null);
    }
  }, [
    activeFlowFilename,
    cancelRename,
    items,
    kind,
    onNodeCatalogChange,
    onReload,
    onSelectFlow,
    projectPath,
    renameTarget?.filename,
  ]);

  return (
    <section className={s.section}>
      <SectionHeader
        title={title}
        subtitle={`${items.length} ${items.length === 1 ? "item" : "items"}`}
        actions={
          <ActionGroup>
            <HeaderButton onClick={onCreateRequest} variant="primary">
              {createLabel}
            </HeaderButton>
            <HeaderButton onClick={onReload}>Reload</HeaderButton>
          </ActionGroup>
        }
      />

      {draftOpen && (
        <InlineDraftForm
          value={draftName}
          error={draftError}
          placeholder={`Enter ${title === "Flows" ? "flow" : "subflow"} name`}
          submitLabel={createLabel}
          onCancel={onDraftCancel}
          onChange={onDraftChange}
          onSubmit={onDraftSubmit}
        />
      )}

      <div className={s.list}>
        {loading ? (
          <EmptyState title={`Loading ${title.toLowerCase()}...`} />
        ) : items.length === 0 ? (
          <EmptyState title={`No ${title.toLowerCase()} yet.`} />
        ) : (
          items.map((item) => (
            <div
              key={item.filename}
              className={`${s.listRow} ${item.filename === activeFlowFilename ? s.listRowActive : ""}`}
            >
              {renameTarget?.filename === item.filename ? (
                <div className={s.rowEditor}>
                  <input
                    autoFocus
                    className={s.inlineInput}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                    placeholder={`Rename ${kind}`}
                  />
                  <div className={s.rowEditorActions}>
                    <CardButton label="Cancel" onClick={cancelRename} />
                    <CardButton
                      label={busyFilename === item.filename ? "Saving..." : "Save"}
                      primary
                      disabled={busyFilename === item.filename}
                      onClick={() => {
                        void submitRename();
                      }}
                    />
                  </div>
                  {renameError && (
                    <div className={`${s.feedbackLine} ${s.feedbackError} ${s.inlineFeedback}`}>
                      {renameError}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className={s.listMainButton}
                    onClick={() => onSelectFlow(item.filename)}
                  >
                    <span className={s.listPrimary}>
                      {runningFlows.has(item.filename) && <span className={s.runningDot} />}
                      <span className={s.listTitle}>{item.name}</span>
                    </span>
                    <span className={s.listMeta}>{item.filename}</span>
                  </button>
                  <div className={s.rowActions}>
                    <CardButton label="Rename" onClick={() => startRename(item)} />
                    <CardButton
                      label={
                        busyFilename === item.filename
                          ? "Deleting..."
                          : confirmDeleteFilename === item.filename
                            ? "Confirm"
                            : "Delete"
                      }
                      danger={confirmDeleteFilename === item.filename}
                      disabled={busyFilename === item.filename}
                      onClick={() => {
                        if (confirmDeleteFilename !== item.filename) {
                          setConfirmDeleteFilename(item.filename);
                          return;
                        }
                        void deleteFlow(item);
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function CustomNodesTab({
  assets,
  loading,
  busyNodeId,
  draftOpen,
  draftName,
  feedback,
  creating,
  onCreateRequest,
  onDraftCancel,
  onDraftChange,
  onDraftSubmit,
  onOpenSource,
  onBuild,
  onReload,
}: {
  assets: CustomNodeAsset[];
  loading: boolean;
  busyNodeId: string | null;
  draftOpen: boolean;
  draftName: string;
  feedback: { kind: "ok" | "error"; message: string } | null;
  creating: boolean;
  onCreateRequest: () => void;
  onDraftCancel: () => void;
  onDraftChange: (value: string) => void;
  onDraftSubmit: () => void;
  onOpenSource: (sourcePath: string) => void;
  onBuild: (asset: CustomNodeAsset) => void;
  onReload: () => void;
}) {
  return (
    <section className={s.section}>
      <SectionHeader
        title="Custom Nodes"
        subtitle={`${assets.length} ${assets.length === 1 ? "asset" : "assets"}`}
        actions={
          <ActionGroup>
            <HeaderButton onClick={onCreateRequest} variant="primary">
              New Node
            </HeaderButton>
            <HeaderButton onClick={onReload}>Reload</HeaderButton>
          </ActionGroup>
        }
      />

      {draftOpen && (
        <InlineDraftForm
          value={draftName}
          error={feedback?.kind === "error" ? feedback.message : null}
          placeholder="Enter custom node name"
          submitLabel={creating ? "Creating..." : "Create Node"}
          submitDisabled={creating}
          onCancel={onDraftCancel}
          onChange={onDraftChange}
          onSubmit={onDraftSubmit}
        />
      )}

      {feedback && !draftOpen && (
        <div className={`${s.feedbackLine} ${feedback.kind === "error" ? s.feedbackError : s.feedbackOk}`}>
          {feedback.message}
        </div>
      )}

      <div className={s.cardGrid}>
        {loading ? (
          <EmptyState title="Loading custom nodes..." />
        ) : assets.length === 0 ? (
          <EmptyState title="No custom nodes found in this project." />
        ) : (
          assets.map((asset) => (
            <div
              key={asset.id}
              className={s.nodeCard}
              onDoubleClick={() => {
                if (asset.sourcePath) onOpenSource(asset.sourcePath);
              }}
            >
              <div className={s.nodeCardTop}>
                <div className={s.nodeCardTitleWrap}>
                  <div className={s.nodeCardTitle}>{asset.name}</div>
                  <div className={s.nodeCardId}>{asset.id}</div>
                </div>
                <span
                  className={`${s.statusBadge} ${
                    asset.status === "invalid"
                      ? s.statusDanger
                      : asset.status === "draft"
                        ? s.statusMuted
                        : s.statusOk
                  }`}
                >
                  {asset.status}
                </span>
              </div>

              <div className={s.nodeCardTags}>
                {asset.canUse && <span className={s.tag}>Artifact</span>}
                {asset.canBuild && <span className={s.tag}>Source</span>}
                {asset.nodes.length > 0 && <span className={s.tag}>{asset.nodes.length} nodes</span>}
              </div>

              {asset.nodes.length > 0 && (
                <div className={s.nodeNames}>
                  {asset.nodes.map((node) => node.name).join(", ")}
                </div>
              )}

              <div className={s.nodePaths}>
                {asset.wasmPath && <div className={s.pathLine}>wasm: {asset.wasmPath}</div>}
                {asset.sourcePath && <div className={s.pathLine}>src: {asset.sourcePath}</div>}
              </div>

              <div className={s.cardActions}>
                {asset.sourcePath && (
                  <CardButton
                    label="Open Source"
                    onClick={() => onOpenSource(asset.sourcePath!)}
                  />
                )}
                {asset.canBuild && (
                  <CardButton
                    label={busyNodeId === asset.id ? "Building..." : "Build Plugin"}
                    primary
                    disabled={busyNodeId === asset.id}
                    onClick={() => onBuild(asset)}
                  />
                )}
              </div>

              {asset.error && (
                <div className={s.nodeError}>{asset.error}</div>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ConsoleTab({
  entries,
  onClear,
}: {
  entries: Array<{
    id: string;
    timestamp: number;
    label: string;
    value: unknown;
  }>;
  onClear: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 24;
  };

  useEffect(() => {
    if (stickToBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <section className={s.section}>
      <SectionHeader
        title="Console"
        subtitle={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
        hint="` to toggle"
        actions={<HeaderButton onClick={onClear}>Clear</HeaderButton>}
      />

      <div ref={listRef} className={s.consoleList} onScroll={onScroll}>
        {entries.length === 0 ? (
          <EmptyState title="No console entries yet." />
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={s.consoleEntry}>
              <span className={s.consoleTime}>{formatTime(entry.timestamp)}</span>
              <span className={s.consoleLabel}>{entry.label}</span>
              <pre className={s.consoleValue}>{formatValue(entry.value)}</pre>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ProblemsTab({
  problems,
}: {
  problems: Array<{ nodeId: string; error: string }>;
}) {
  return (
    <section className={s.section}>
      <SectionHeader
        title="Problems"
        subtitle={`${problems.length} ${problems.length === 1 ? "issue" : "issues"}`}
      />

      <div className={s.list}>
        {problems.length === 0 ? (
          <EmptyState title="No problems captured in the latest run." />
        ) : (
          problems.map((problem) => (
            <div key={problem.nodeId} className={`${s.problemRow} ${s.problemRowDanger}`}>
              <div className={s.problemNode}>{problem.nodeId}</div>
              <div className={s.problemText}>{problem.error}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  subtitle,
  actions,
  hint,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  hint?: string;
}) {
  return (
    <div className={s.sectionHeader}>
      <div className={s.sectionTitleWrap}>
        <div className={s.sectionTitle}>{title}</div>
        {subtitle && <div className={s.sectionSubtitle}>{subtitle}</div>}
      </div>
      <div className={s.sectionActions}>
        {hint && <span className={s.sectionHint}>{hint}</span>}
        {actions}
      </div>
    </div>
  );
}

function ActionGroup({ children }: { children: ReactNode }) {
  return <div className={s.actionGroup}>{children}</div>;
}

function HeaderButton({
  children,
  onClick,
  variant = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "default" | "primary";
}) {
  return (
    <button
      type="button"
      className={`${s.headerButton} ${variant === "primary" ? s.headerButtonPrimary : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CardButton({
  label,
  onClick,
  primary = false,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`${s.cardButton} ${primary ? s.cardButtonPrimary : ""} ${danger ? s.cardButtonDanger : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function InlineDraftForm({
  value,
  error,
  placeholder,
  submitLabel,
  submitDisabled = false,
  onCancel,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string | null;
  placeholder: string;
  submitLabel: string;
  submitDisabled?: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className={s.inlineForm}>
      <input
        autoFocus
        className={s.inlineInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
      />
      <div className={s.formButtons}>
        <HeaderButton onClick={onCancel}>Cancel</HeaderButton>
        <HeaderButton onClick={onSubmit} variant="primary">
          {submitLabel}
        </HeaderButton>
      </div>
      {error && <div className={`${s.feedbackLine} ${s.feedbackError}`}>{error}</div>}
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return <div className={s.emptyState}>{title}</div>;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
