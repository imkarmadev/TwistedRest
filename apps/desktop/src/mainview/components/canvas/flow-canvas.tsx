/**
 * The main React Flow canvas.
 *
 * Loads a flow by id, renders nodes/edges, autosaves on change, and lets the
 * user drop new HttpRequest nodes via a "+" button on the toolbar.
 *
 * Persistence model: a flow is loaded once on `flowId` change, then mutations
 * stay in local React Flow state. A debounced effect pushes the latest
 * (nodes, edges) snapshot to the bun side.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type DefaultEdgeOptions,
  type FinalConnectionState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { invoke } from "@tauri-apps/api/core";
import {
  runFlow,
  type ExecHttpRequest,
  type ExecHttpResponse,
  type NodeStatus,
  type DataType,
} from "@twistedrest/core";

import type { RPC, ProjectDetail, Environment } from "../../use-tauri";
import { NodePalette } from "./node-palette";
import {
  NODE_TYPES_MAP,
  NODE_REGISTRY,
  findNodeDef,
  type NodeTypeDef,
} from "../../lib/node-registry";
import {
  computeHttpRequestPins,
  computeStartPins,
  computeEnvVarPins,
  computeBreakObjectPins,
  computeForEachPins,
  computeConvertPins,
  computeTapPins,
  computeLogPins,
  computeMakeObjectPins,
  computeFunctionPins,
  computeMatchPins,
  computeEmitEventPins,
  computeOnEventPins,
  type ComputedPins,
  type PayloadField,
} from "../../lib/node-pins";
import { evalZodSchema } from "../../lib/eval-schema";
import { getInputPinSourceType, getSourcePinType } from "../../lib/schema-resolution";
import { FlowExecContext, type FlowExecContextValue } from "../../lib/exec-context";
import s from "./flow-canvas.module.css";

interface FlowCanvasProps {
  rpc: RPC;
  flowId: string;
  selectedNode: Node | null;
  onSelectionChange: (node: Node | null) => void;
  /** Bound from parent so the inspector can mutate node data via callback. */
  registerUpdateNodeData: (fn: (id: string, data: Record<string, unknown>) => void) => void;
  registerDeleteNode: (fn: (id: string) => void) => void;
  /** Active project metadata — drives baseUrl + default headers at run time. */
  project: ProjectDetail | null;
  /** Available environments — Start node renders the selector from these. */
  environments: Environment[];
  /** Notifies the parent (App) of the latest per-node run results, so the
      Inspector (mounted outside the canvas) can show them. */
  onResultsChange: (results: Record<string, Record<string, unknown>>) => void;
  /** Same pattern for errors. */
  onErrorsChange: (errors: Record<string, string>) => void;
  /** Raw response bodies captured on schema validation failure. */
  onRawResponsesChange: (raw: Record<string, unknown>) => void;
  /**
   * Hands the parent a closure that resolves the type of a node's input
   * pin against the live graph. The Inspector uses this for the smart
   * Convert node dropdown — it lives outside the React Flow tree so it
   * can't read nodes/edges directly.
   */
  registerGetInputType: (
    fn: (nodeId: string, inputPinId: string) => DataType,
  ) => void;
  /** Console panel append callback — Log nodes call into this. */
  onLog: (entry: { nodeId: string; label: string; value: unknown }) => void;
}

/**
 * Domain node shape stored in SQLite (matches packages/shared FlowNode).
 * Translated to/from React Flow's Node<T> on load and save.
 */
interface DomainNode {
  id: string;
  kind: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

interface DomainEdge {
  id: string;
  kind: "exec" | "data";
  fromNode: string;
  fromPin: string;
  toNode: string;
  toPin: string;
}

// Sourced from the node registry — adding a new type only requires
// editing lib/node-registry.ts.
const NODE_TYPES = NODE_TYPES_MAP;

const DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = {
  type: "default",
  style: { strokeWidth: 2 },
};

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({
  rpc,
  flowId,
  onSelectionChange,
  registerUpdateNodeData,
  registerDeleteNode,
  project,
  environments,
  onResultsChange,
  onErrorsChange,
  onRawResponsesChange,
  registerGetInputType,
  onLog,
}: FlowCanvasProps) {
  const reactFlow = useReactFlow();
  const rfUpdateNodeInternals = useUpdateNodeInternals();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Palette state ─────────────────────────────────────────
  // Open when the user right-clicks the pane, drops a pin onto empty
  // canvas, or hits Space. The pendingConnection (if set) means we
  // arrived here from a drag-pin-to-empty-canvas drop and should
  // auto-wire after spawning. The sourceDataType (for data drops)
  // narrows the palette filter to nodes that can actually accept this
  // pin type — e.g. dragging a number won't suggest BreakObject.
  const [palette, setPalette] = useState<{
    screenPos: { x: number; y: number };
    flowPos: { x: number; y: number };
    pendingConnection?: {
      sourceId: string;
      sourceHandle: string;
      sourceKind: "exec" | "data";
      sourceDataType?: DataType;
    };
  } | null>(null);

  // ── Executor state — never persisted, lives only for the current run ──
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [results, setResults] = useState<Record<string, Record<string, unknown>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /**
   * Raw parsed response bodies captured when schema validation fails.
   * The inspector uses these to power the "Generate schema from this
   * response" recovery action.
   */
  const [rawResponses, setRawResponses] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  /** AbortController for the current run. Signalling it stops the executor
   *  at the next node boundary. */
  const abortRef = useRef<AbortController | null>(null);

  // Always-fresh refs so the run handler closes over the latest graph
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Push results + errors + rawResponses upward so the Inspector can render them.
  useEffect(() => {
    onResultsChange(results);
  }, [results, onResultsChange]);
  useEffect(() => {
    onErrorsChange(errors);
  }, [errors, onErrorsChange]);
  useEffect(() => {
    onRawResponsesChange(rawResponses);
  }, [rawResponses, onRawResponsesChange]);

  // Re-register the type-resolver closure on every nodes/edges change so the
  // Inspector always queries against the current graph snapshot.
  useEffect(() => {
    registerGetInputType((nodeId, inputPinId) =>
      getInputPinSourceType(nodeId, inputPinId, nodes, edges),
    );
  }, [nodes, edges, registerGetInputType]);

  // Track whether the current state came from the server (skip first save).
  const justLoadedRef = useRef(true);

  /** Live viewport ref — updated by onMoveEnd, read by the autosave. */
  const viewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  /** Tick counter — incremented on every pan/zoom end to trigger autosave
   *  even when nodes/edges haven't changed. */
  const [viewportTick, setViewportTick] = useState(0);
  /** True after the first successful load — used to guard the cleanup
   *  save from firing with stale/default data during transitions. */
  const hasLoadedRef = useRef(false);

  /** Called by React Flow when the user finishes panning or zooming. */
  const onMoveEnd = useCallback((_: unknown, vp: { x: number; y: number; zoom: number }) => {
    viewportRef.current = vp;
    setViewportTick((t) => t + 1);
  }, []);

  /** Minimap visibility — toggled with M key. Default hidden. */
  const [showMinimap, setShowMinimap] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setShowMinimap((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Load flow on flowId change ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    justLoadedRef.current = true;
    hasLoadedRef.current = false;

    void rpc.request.getFlow({ id: flowId }).then((flow) => {
      if (cancelled || !flow) return;
      const domainNodes = (flow.nodes as DomainNode[]) ?? [];
      const domainEdges = (flow.edges as DomainEdge[]) ?? [];
      setNodes(domainNodes.map(domainToRf));
      setEdges(domainEdges.map(domainEdgeToRf));

      // Restore saved viewport or fit. We use a timeout to let React
      // Flow fully process the new nodes before manipulating the viewport.
      const vp = (flow as unknown as Record<string, unknown>).viewport as
        | { x: number; y: number; zoom: number }
        | undefined;
      const hasSavedViewport = vp && typeof vp.x === "number" && typeof vp.zoom === "number";
      if (hasSavedViewport) {
        viewportRef.current = vp;
      }

      hasLoadedRef.current = true;
      setLoading(false);

      // Delay viewport restore so React Flow has time to measure nodes.
      setTimeout(() => {
        if (cancelled) return;
        if (hasSavedViewport) {
          reactFlow.setViewport(vp);
        } else {
          reactFlow.fitView({ padding: 0.35 });
        }
      }, 50);
    });

    return () => {
      cancelled = true;
      // Force-save current state before unloading, but ONLY if:
      //   1. We successfully loaded this flow
      //   2. There are actual nodes to save (prevents wiping a flow
      //      when cleanup fires during a transitional empty state)
      if (hasLoadedRef.current && nodesRef.current.length > 0) {
        void rpc.request.saveFlow({
          id: flowId,
          nodes: nodesRef.current.map(rfToDomain),
          edges: edgesRef.current.map(rfEdgeToDomain),
          viewport: viewportRef.current,
        });
      }
    };
  }, [rpc, flowId, reactFlow]);

  // ── Debounced autosave (nodes + edges + viewport) ──────────
  // Fires on node/edge changes AND on viewport changes (via viewportTick).
  useEffect(() => {
    if (loading) return;
    if (justLoadedRef.current) {
      justLoadedRef.current = false;
      return;
    }
    // Never save an empty flow — prevents wiping data during transitions.
    if (nodes.length === 0) return;
    const t = setTimeout(() => {
      const domainNodes = nodes.map(rfToDomain);
      const domainEdges = edges.map(rfEdgeToDomain);
      void rpc.request.saveFlow({
        id: flowId,
        nodes: domainNodes,
        edges: domainEdges,
        viewport: viewportRef.current,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [nodes, edges, viewportTick, rpc, flowId, loading]);

  // ── React Flow handlers ────────────────────────────────────
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      // Bubble selection changes up so the inspector can react
      for (const ch of changes) {
        if (ch.type === "select") {
          if (ch.selected) {
            // Look up the actual node in the next tick — selection events
            // arrive before the node list applies the change.
            setNodes((nds) => {
              const found = nds.find((n) => n.id === ch.id);
              if (found) onSelectionChange(found);
              return nds;
            });
          } else {
            onSelectionChange(null);
          }
        }
      }
    },
    [onSelectionChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const onConnect = useCallback(
    (conn: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...conn,
            id: crypto.randomUUID(),
            // Exec pins always have ids starting with "exec"; everything else is data.
            data: { kind: conn.sourceHandle?.startsWith("exec") ? "exec" : "data" },
          },
          eds,
        ),
      ),
    [],
  );

  // ── Update a single node's data (called from the inspector) ─
  const updateNodeData = useCallback(
    (id: string, data: Record<string, unknown>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data } : n)));
      // Pin set may have changed — drop edges referencing pins that no longer exist.
      // We do this in a microtask so it sees the just-updated node list.
      queueMicrotask(() => {
        setNodes((latestNodes) => {
          setEdges((eds) => cullDanglingEdges(eds, latestNodes));
          return latestNodes;
        });
        // Force React Flow to re-scan this node's Handle elements.
        // Without this, newly-created pins (from typing #{token} in the
        // URL/body/headers) aren't indexed as valid connection targets
        // until the next unrelated re-render. The edge exists in state
        // but doesn't paint because RF doesn't know the handle is there.
        rfUpdateNodeInternals(id);
      });
    },
    [rfUpdateNodeInternals],
  );

  const deleteNode = useCallback((id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    onSelectionChange(null);
  }, [onSelectionChange]);

  // Expose those callbacks to the parent so the inspector can drive them.
  useEffect(() => registerUpdateNodeData(updateNodeData), [registerUpdateNodeData, updateNodeData]);
  useEffect(() => registerDeleteNode(deleteNode), [registerDeleteNode, deleteNode]);

  // Active env = the one selected on the Start node. Recomputes whenever
  // the user changes the dropdown (which mutates the start node's data,
  // which updates the nodes state).
  const activeEnvironment = useMemo(() => {
    const startNode = nodes.find((n) => n.type === "start");
    const envId = (startNode?.data as { environmentId?: string } | undefined)?.environmentId;
    if (!envId) return null;
    return environments.find((e) => e.id === envId) ?? null;
  }, [nodes, environments]);

  // Pre-flight validation: walks every node, returns the first reason the
  // flow can't run (or null if it can). The Start node uses this to disable
  // the Run button and show a tooltip.
  const validation = useMemo(
    () => validateFlow(nodes, edges, activeEnvironment),
    [nodes, edges, activeEnvironment],
  );

  // ── Flow execution ─────────────────────────────────────────
  const run = useCallback(() => {
    if (running) return;
    // Re-check validation at the moment of execution. Belt + suspenders —
    // the Start node already disables the button, but we don't want a
    // stale call to slip through.
    const check = validateFlow(nodesRef.current, edgesRef.current, activeEnvironment);
    if (!check.canRun) {
      console.warn("[runFlow] blocked:", check.reason);
      return;
    }
    setStatuses({});
    setResults({});
    setErrors({});
    setRawResponses({});
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Resolve the active environment from the Start node's config
    const startNode = nodesRef.current.find((n) => n.type === "start");
    const envId = (startNode?.data as { environmentId?: string } | undefined)?.environmentId;
    const env = environments.find((e) => e.id === envId);
    const envVars: Record<string, unknown> = {};
    for (const v of env?.vars ?? []) {
      envVars[v.key] = v.value;
    }

    void runFlow({
      nodes: nodesRef.current as never,
      edges: edgesRef.current as never,
      fetch: (req: ExecHttpRequest) =>
        invoke<ExecHttpResponse>("http_request", { req }),
      evalSchema: (src) => {
        const r = evalZodSchema(src);
        return r.ok ? r.schema! : null;
      },
      onLog,
      signal: controller.signal,
      onStatus: (id, event) => {
        setStatuses((prev) => ({ ...prev, [id]: event.status }));
        if (event.output) {
          setResults((prev) => ({ ...prev, [id]: event.output! }));
        }
        if (event.error) {
          setErrors((prev) => ({ ...prev, [id]: event.error! }));
        }
        if (event.rawResponse !== undefined) {
          setRawResponses((prev) => ({ ...prev, [id]: event.rawResponse }));
        }
      },
      context: {
        projectBaseUrl: project?.baseUrl,
        envBaseUrl: env?.baseUrl,
        projectHeaders: project?.headers,
        envHeaders: env?.headers,
        envVars,
        auth: env?.auth
          ? {
              authType: env.auth.authType,
              bearerToken: env.auth.bearerToken,
              basicUsername: env.auth.basicUsername,
              basicPassword: env.auth.basicPassword,
              apiKeyName: env.auth.apiKeyName,
              apiKeyValue: env.auth.apiKeyValue,
              apiKeyLocation: env.auth.apiKeyLocation,
              oauth2AccessToken: env.auth.oauth2AccessToken,
            }
          : undefined,
      },
    })
      .catch((err) => {
        console.error("[runFlow]", err);
      })
      .finally(() => {
        setRunning(false);
        abortRef.current = null;
      });
  }, [running, project, environments, activeEnvironment, onLog]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const execContextValue = useMemo<FlowExecContextValue>(
    () => ({
      run,
      stop,
      statuses,
      results,
      errors,
      running,
      project,
      environments,
      activeEnvironment,
      canRun: validation.canRun,
      runDisabledReason: validation.reason,
    }),
    [
      run,
      stop,
      statuses,
      results,
      errors,
      running,
      project,
      environments,
      activeEnvironment,
      validation,
    ],
  );

  // ── Spawn a node from a registry def at a given flow position ─
  // Optionally auto-wires a pending edge from a previous pin drop.
  const spawnFromDef = useCallback(
    (
      def: NodeTypeDef,
      flowPos: { x: number; y: number },
      pendingConnection?: {
        sourceId: string;
        sourceHandle: string;
        sourceKind: "exec" | "data";
      },
    ) => {
      const newId = crypto.randomUUID();
      setNodes((nds) => [
        ...nds,
        {
          id: newId,
          type: def.type,
          position: flowPos,
          data: def.defaultData(),
        },
      ]);

      // Auto-wire if we got here from a drag-pin-to-empty-canvas drop.
      // For exec drops we wire to the new node's `defaultExecInPin`,
      // for data drops we use `defaultDataInPin`.
      if (pendingConnection) {
        const targetHandle =
          pendingConnection.sourceKind === "exec"
            ? def.defaultExecInPin
            : def.defaultDataInPin;
        if (targetHandle) {
          setEdges((eds) => [
            ...eds,
            {
              id: crypto.randomUUID(),
              source: pendingConnection.sourceId,
              sourceHandle: pendingConnection.sourceHandle,
              target: newId,
              targetHandle,
              data: { kind: pendingConnection.sourceKind },
            },
          ]);
        }
      }
    },
    [],
  );

  // ── Open the palette at the canvas center ───────────────────
  const openPaletteAtCenter = useCallback(() => {
    const centerScreen = {
      x: window.innerWidth / 2 - 160,
      y: window.innerHeight / 2 - 200,
    };
    const flowPos = reactFlow.screenToFlowPosition({
      x: centerScreen.x + 160,
      y: centerScreen.y + 200,
    });
    setPalette({ screenPos: centerScreen, flowPos });
  }, [reactFlow]);

  // ── Right-click on the canvas pane → palette at click position ─
  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const screenPos = { x: e.clientX, y: e.clientY };
      const flowPos = reactFlow.screenToFlowPosition(screenPos);
      setPalette({ screenPos, flowPos });
    },
    [reactFlow],
  );

  // ── Drop a pin onto empty canvas → palette filtered by source ─
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // If the connection landed on a valid target, React Flow already
      // fired onConnect — nothing more to do here.
      if (connectionState.isValid) return;
      // If the user dropped ON a node (even if React Flow considered the
      // specific handle invalid), DON'T open the palette — they're trying
      // to make a regular connection and the palette would steal the
      // event from a retry. Only open when the drop was on empty canvas.
      if (connectionState.toNode) return;
      // Need a source node + handle to know what to filter by
      const fromNode = connectionState.fromNode;
      const fromHandle = connectionState.fromHandle;
      if (!fromNode || !fromHandle) return;

      const handleId = fromHandle.id ?? "";
      const sourceKind: "exec" | "data" = handleId.startsWith("exec")
        ? "exec"
        : "data";

      // For data drops, resolve the actual type of the source pin so the
      // palette can filter to nodes that can accept it.
      let sourceDataType: DataType | undefined;
      if (sourceKind === "data") {
        const sourceNode = nodes.find((n) => n.id === fromNode.id);
        if (sourceNode) {
          sourceDataType = getSourcePinType(
            sourceNode,
            handleId.replace(/^out:/, ""),
            nodes,
            edges,
          );
        }
      }

      const clientX =
        "clientX" in event ? event.clientX : event.changedTouches?.[0]?.clientX ?? 0;
      const clientY =
        "clientY" in event ? event.clientY : event.changedTouches?.[0]?.clientY ?? 0;

      const screenPos = { x: clientX, y: clientY };
      const flowPos = reactFlow.screenToFlowPosition(screenPos);

      setPalette({
        screenPos,
        flowPos,
        pendingConnection: {
          sourceId: fromNode.id,
          sourceHandle: handleId,
          sourceKind,
          sourceDataType,
        },
      });
    },
    [reactFlow, nodes, edges],
  );

  // ── Space shortcut: open palette at center ──────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs/textareas
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;

      if (e.code === "Space" && !palette) {
        e.preventDefault();
        openPaletteAtCenter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPaletteAtCenter, palette]);

  const nodeTypes = useMemo(() => NODE_TYPES, []);

  return (
    <FlowExecContext.Provider value={execContextValue}>
      <div className={s.canvas}>
        <div className={s.toolbar}>
          <button className={s.toolBtn} onClick={openPaletteAtCenter} title="Right-click canvas, drag a pin to empty space, or press Space">
            + Add Node
          </button>
        </div>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onPaneContextMenu={onPaneContextMenu}
          onMoveEnd={onMoveEnd}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="rgba(255,255,255,0.05)" />
          <Controls className={s.controls} position="top-left" />
          {showMinimap && <MiniMap pannable zoomable className={s.minimap} />}
        </ReactFlow>


        {palette && (
          <NodePalette
            position={palette.screenPos}
            title={
              palette.pendingConnection
                ? palette.pendingConnection.sourceKind === "exec"
                  ? "Add exec node"
                  : `Add node accepting ${palette.pendingConnection.sourceDataType ?? "value"}`
                : "Add Node"
            }
            filter={(def) => {
              // Hide singletons that already exist
              if (def.singleton && nodes.some((n) => n.type === def.type)) return false;

              // Unfiltered (right-click / Space) — show everything
              if (!palette.pendingConnection) return true;

              // Exec drops: anything with an exec input pin works
              if (palette.pendingConnection.sourceKind === "exec") {
                return def.hasExecIn;
              }

              // Data drops: must have a data input AND that input must
              // accept the dragged source's type. Default for nodes
              // without a strict acceptsDataInput is "accept anything".
              if (!def.hasDataIn) return false;
              const srcType = palette.pendingConnection.sourceDataType ?? "unknown";
              if (def.acceptsDataInput) return def.acceptsDataInput(srcType);
              return true;
            }}
            onSelect={(def) => {
              spawnFromDef(def, palette.flowPos, palette.pendingConnection);
              setPalette(null);
            }}
            onClose={() => setPalette(null)}
          />
        )}
      </div>
    </FlowExecContext.Provider>
  );
}

// ─── Domain ↔ React Flow translators ───────────────────────────

function domainToRf(n: DomainNode): Node {
  return {
    id: n.id,
    type: kindToType(n.kind),
    position: n.position,
    data: (n.config ?? {}) as Record<string, unknown>,
  };
}

function rfToDomain(n: Node): DomainNode {
  return {
    id: n.id,
    kind: typeToKind(n.type ?? "httpRequest"),
    position: { x: n.position.x, y: n.position.y },
    config: (n.data ?? {}) as Record<string, unknown>,
  };
}

function domainEdgeToRf(e: DomainEdge): Edge {
  return {
    id: e.id,
    source: e.fromNode,
    sourceHandle: e.fromPin,
    target: e.toNode,
    targetHandle: e.toPin,
    data: { kind: e.kind },
  };
}

function rfEdgeToDomain(e: Edge): DomainEdge {
  const kind = ((e.data as { kind?: "exec" | "data" } | undefined)?.kind ?? "data") as
    | "exec"
    | "data";
  return {
    id: e.id,
    kind,
    fromNode: e.source,
    fromPin: e.sourceHandle ?? "",
    toNode: e.target,
    toPin: e.targetHandle ?? "",
  };
}

/**
 * Pre-flight validation. Returns the first reason the flow can't be run,
 * or null if it's good to go. Cheap — just walks the node list and reads
 * data fields. The Start node consumes this via FlowExecContext.
 *
 * Rules in order:
 *   1. Must have a Start node.
 *   2. If any EnvVar nodes exist, the Start node must have an environment selected.
 *   3. Every EnvVar node must have a varKey picked.
 *   4. Every EnvVar node's varKey must exist in the active environment's vars.
 *   5. Every HTTP Request node must have a URL.
 */
function validateFlow(
  nodes: Node[],
  edges: Edge[],
  activeEnvironment: { name: string; vars: Array<{ key: string }> } | null,
): { canRun: boolean; reason: string | null } {
  const start = nodes.find((n) => n.type === "start");
  if (!start) return { canRun: false, reason: "Flow has no Start node" };

  const envVarNodes = nodes.filter((n) => n.type === "envVar");

  if (envVarNodes.length > 0 && !activeEnvironment) {
    return {
      canRun: false,
      reason: "Pick an environment on the Start node — env-var nodes need one",
    };
  }

  for (const node of envVarNodes) {
    const varKey = (node.data as { varKey?: string } | undefined)?.varKey;
    if (!varKey) {
      return { canRun: false, reason: "An EnvVar node has no variable selected" };
    }
    if (activeEnvironment && !activeEnvironment.vars.find((v) => v.key === varKey)) {
      return {
        canRun: false,
        reason: `Variable "${varKey}" is not defined in env "${activeEnvironment.name}"`,
      };
    }
  }

  for (const node of nodes) {
    if (node.type !== "httpRequest") continue;
    const url = (node.data as { url?: string } | undefined)?.url;
    if (!url || !url.trim()) {
      return { canRun: false, reason: "An HTTP node has no URL" };
    }
  }

  // ForEach nodes must have an array input wired
  for (const node of nodes) {
    if (node.type !== "forEachSequential" && node.type !== "forEachParallel") continue;
    const hasArray = edges.some(
      (e) => e.target === node.id && e.targetHandle === "in:array",
    );
    if (!hasArray) {
      return { canRun: false, reason: "A ForEach node has no array input connected" };
    }
  }

  return { canRun: true, reason: null };
}

/**
 * After a node's data changes, the set of pins it exposes may shrink.
 * Drop any edges whose source or target handle no longer exists.
 */
function cullDanglingEdges(edges: Edge[], nodes: Node[]): Edge[] {
  const pinIndex = new Map<string, Set<string>>();
  const nodeIndex = new Map<string, Node>();
  for (const n of nodes) {
    pinIndex.set(n.id, collectPinIds(n));
    nodeIndex.set(n.id, n);
  }
  return edges.filter((e) => {
    const srcNode = nodeIndex.get(e.source);
    const tgtPins = pinIndex.get(e.target);
    if (!srcNode || !tgtPins) return false;
    // Break-Object and On Event have dynamic output pins (Break-Object
    // mirrors a source schema, On Event mirrors an emitter's payload).
    // collectPinIds can't enumerate them, so we skip outgoing-pin
    // validation for those sources.
    if (srcNode.type !== "breakObject" && srcNode.type !== "onEvent") {
      const srcPins = pinIndex.get(e.source);
      if (e.sourceHandle && !srcPins?.has(e.sourceHandle)) return false;
    }
    if (e.targetHandle && !tgtPins.has(e.targetHandle)) return false;
    return true;
  });
}

function collectPinIds(node: Node): Set<string> {
  let pins: ComputedPins;
  if (node.type === "start") pins = computeStartPins();
  else if (node.type === "httpRequest") pins = computeHttpRequestPins(node.data ?? {});
  else if (node.type === "envVar")
    pins = computeEnvVarPins((node.data as { varKey?: string } | undefined)?.varKey);
  else if (node.type === "breakObject") pins = computeBreakObjectPins();
  else if (node.type === "forEachSequential" || node.type === "forEachParallel")
    pins = computeForEachPins();
  else if (node.type === "convert")
    pins = computeConvertPins(
      (node.data as { targetType?: string } | undefined)?.targetType,
    );
  else if (node.type === "tap") pins = computeTapPins();
  else if (node.type === "log") pins = computeLogPins();
  else if (node.type === "match")
    pins = computeMatchPins(
      (node.data as { cases?: Array<{ value: string; label?: string }> } | undefined)?.cases,
    );
  else if (node.type === "function") {
    const fd = node.data as { inputs?: PayloadField[]; outputs?: PayloadField[] } | undefined;
    pins = computeFunctionPins(fd?.inputs, fd?.outputs);
  } else if (node.type === "makeObject")
    pins = computeMakeObjectPins(
      (node.data as { fields?: PayloadField[] } | undefined)?.fields,
    );
  else if (node.type === "emitEvent")
    pins = computeEmitEventPins(
      (node.data as { payload?: PayloadField[] } | undefined)?.payload,
    );
  else if (node.type === "onEvent") {
    // OnEvent payload pins are dynamic — depend on matching emitter(s).
    // We can't enumerate them statically here without scanning all nodes,
    // so we only return the static pins (exec-out). Edges from dynamic
    // payload pins are protected from culling the same way Break-Object's
    // dynamic outputs are.
    pins = computeOnEventPins();
  } else pins = { inputs: [], outputs: [] };
  return new Set([...pins.inputs.map((p) => p.id), ...pins.outputs.map((p) => p.id)]);
}

// Kind ↔ React Flow type are 1:1 — pass-through with a fallback for
// forward compatibility.
const KNOWN_TYPES = new Set([
  "start",
  "httpRequest",
  "envVar",
  "breakObject",
  "forEachSequential",
  "forEachParallel",
  "convert",
  "tap",
  "log",
  "makeObject",
  "function",
  "match",
  "emitEvent",
  "onEvent",
]);

function kindToType(kind: string): string {
  return KNOWN_TYPES.has(kind) ? kind : "httpRequest";
}

function typeToKind(type: string): string {
  return KNOWN_TYPES.has(type) ? type : "httpRequest";
}
