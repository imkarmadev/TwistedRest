/**
 * The main React Flow canvas.
 *
 * Loads a flow by id, renders nodes/edges, autosaves on change, and exposes
 * palette/build actions to the surrounding app shell.
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
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  type NodeStatus,
  type DataType,
} from "@twistedflow/core";

import { NodePalette } from "./node-palette";
import { CustomNode } from "./nodes/custom-node";
import { PluginNode, type PluginNodeDef } from "./nodes/plugin-node";
import { SubflowCallNode, SubflowNavContext, type SubflowDef } from "./nodes/subflow-call-node";
import { GroupNode, GroupCallbacksContext, type GroupNodeCallbacks } from "./nodes/group-node";
import { PhantomInputsNode, PhantomOutputsNode } from "./nodes/phantom-boundary-node";
import {
  applyGroups,
  createGroup,
  ungroup as ungroupOp,
  toggleCollapsed,
  renameGroup,
  GROUP_NODE_TYPE,
  PHANTOM_INPUTS_TYPE,
  PHANTOM_OUTPUTS_TYPE,
  type GroupMeta,
} from "../../lib/groups";
import {
  NODE_TYPES_MAP,
  NODE_REGISTRY,
  findNodeDef,
  type NodeTypeDef,
  type NodeCategory,
} from "../../lib/node-registry";
import { cullDanglingEdges } from "../../lib/canvas-pin-ids";
import { getInputPinSourceType, getSourcePinType } from "../../lib/schema-resolution";
import { FlowExecContext, type FlowExecContextValue, type ProjectEnvironment } from "../../lib/exec-context";
import { FlowVariablesContext, type FlowVariable } from "../../lib/variables-context";
import { FlowInterfaceContext, type Interface } from "../../lib/flow-interface-context";
import s from "./flow-canvas.module.css";

interface FlowCanvasProps {
  projectPath: string;
  flowFilename: string;
  /** Bumps when external actions add/remove project-local nodes or subflows. */
  nodeCatalogVersion?: number;
  /** True when this flow is currently executing (managed by App). */
  running: boolean;
  selectedNode: Node | null;
  onSelectionChange: (node: Node | null) => void;
  /** Bound from parent so the inspector can mutate node data via callback. */
  registerUpdateNodeData: (fn: (id: string, data: Record<string, unknown>) => void) => void;
  registerDeleteNode: (fn: (id: string) => void) => void;
  registerOpenPalette?: (fn: () => void) => void;
  registerBuildFlow?: (fn: () => void) => void;
  /** Available environments — Start node renders the selector from these. */
  environments: ProjectEnvironment[];
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
  /** Notifies the parent of the latest variable declarations (same pattern as onResultsChange). */
  onVariablesChange?: (variables: FlowVariable[]) => void;
  /** Registers a setter so the parent (App / Inspector) can push variable changes
   *  back into the canvas — same pattern as registerUpdateNodeData. */
  registerSetVariables?: (fn: (vars: FlowVariable[]) => void) => void;
  /** Notifies the parent of the latest subflow interface (subflow files only). */
  onInterfaceChange?: (iface: Interface | null) => void;
  /** Registers a setter so the parent Inspector can push interface edits back. */
  registerSetInterface?: (fn: (iface: Interface) => void) => void;
  /** Navigate to another flow (double-click a subflow call node). */
  onSelectFlow: (filename: string) => void;
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

// Sourced from the node registry + custom nodes.
const NODE_TYPES = {
  ...NODE_TYPES_MAP,
  customNode: CustomNode,
  pluginNode: PluginNode,
  subflowCall: SubflowCallNode,
  [GROUP_NODE_TYPE]: GroupNode,
  [PHANTOM_INPUTS_TYPE]: PhantomInputsNode,
  [PHANTOM_OUTPUTS_TYPE]: PhantomOutputsNode,
};

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
  projectPath,
  flowFilename,
  nodeCatalogVersion = 0,
  running,
  onSelectionChange,
  registerUpdateNodeData,
  registerDeleteNode,
  registerOpenPalette,
  registerBuildFlow,
  environments,
  onResultsChange,
  onErrorsChange,
  onRawResponsesChange,
  registerGetInputType,
  onLog,
  onVariablesChange,
  registerSetVariables,
  onInterfaceChange,
  registerSetInterface,
  onSelectFlow,
}: FlowCanvasProps) {
  const reactFlow = useReactFlow();
  const rfUpdateNodeInternals = useUpdateNodeInternals();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [variables, setVariables] = useState<FlowVariable[]>([]);
  const [flowInterface, setFlowInterface] = useState<Interface | null>(null);
  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  // Always-fresh refs so the run handler closes over the latest graph
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const variablesRef = useRef(variables);
  const interfaceRef = useRef<Interface | null>(flowInterface);
  const groupsRef = useRef<GroupMeta[]>(groups);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  useEffect(() => {
    variablesRef.current = variables;
  }, [variables]);
  useEffect(() => {
    interfaceRef.current = flowInterface;
  }, [flowInterface]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  // Reset drill-down when switching flows.
  useEffect(() => {
    setSelectedGroupId(null);
    setFocusedGroupId(null);
  }, [flowFilename]);

  // ── Always-on event listeners scoped by flowFilename ──
  // These run regardless of whether *this* canvas started the run —
  // reconnects automatically when switching back to a running flow.
  useEffect(() => {
    let unlistenStatus: UnlistenFn | null = null;
    let unlistenLog: UnlistenFn | null = null;

    void (async () => {
      unlistenStatus = await listen<{
        flowId: string;
        nodeId: string;
        status: NodeStatus;
        output?: Record<string, unknown>;
        error?: string;
        rawResponse?: unknown;
      }>("flow:status", (e) => {
        if (e.payload.flowId !== flowFilename) return;
        const { nodeId, status, output, error, rawResponse } = e.payload;
        setStatuses((prev) => ({ ...prev, [nodeId]: status }));
        if (output) {
          setResults((prev) => ({ ...prev, [nodeId]: output }));
        }
        if (error) {
          setErrors((prev) => ({ ...prev, [nodeId]: error }));
        }
        if (rawResponse !== undefined) {
          setRawResponses((prev) => ({ ...prev, [nodeId]: rawResponse }));
        }
      });

      unlistenLog = await listen<{
        flowId: string;
        nodeId: string;
        label: string;
        value: unknown;
      }>("flow:log", (e) => {
        if (e.payload.flowId !== flowFilename) return;
        onLog(e.payload);
      });
    })();

    return () => {
      unlistenStatus?.();
      unlistenLog?.();
    };
  }, [flowFilename, onLog]);

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

  // Push variables upward so the Inspector can render the Variables Panel.
  useEffect(() => {
    onVariablesChange?.(variables);
  }, [variables, onVariablesChange]);

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

  // No frontend-defined custom node defs here — project-local custom nodes are
  // discovered from the Rust backend and arrive as plugin palette entries.
  const customPaletteEntries = useMemo<NodeTypeDef[]>(() => [], []);

  // Load WASM plugin + subflow node metadata from Rust backend
  const [pluginDefs, setPluginDefs] = useState<PluginNodeDef[]>([]);
  const [subflowDefs, setSubflowDefs] = useState<SubflowDef[]>([]);
  useEffect(() => {
    void invoke<Array<{
      name: string;
      typeId: string;
      category: string;
      description: string;
      inputs?: Array<{ key: string; dataType: string }>;
      outputs?: Array<{ key: string; dataType: string }>;
    }>>("list_node_types", { projectPath }).then((all) => {
      const builtinTypes = new Set(NODE_REGISTRY.map((n) => n.type));
      // WASM plugins: typeId not in built-ins and not starting with "fn:"
      const plugins = all.filter(
        (n) => !builtinTypes.has(n.typeId) && !n.typeId.startsWith("fn:"),
      );
      setPluginDefs(
        plugins.map((n) => ({
          name: n.name,
          typeId: n.typeId,
          category: n.category,
          description: n.description ?? "",
          inputs: n.inputs ?? [],
          outputs: n.outputs ?? [],
        })),
      );
      // Subflows: typeId starts with "fn:"
      const subflows = all.filter((n) => n.typeId.startsWith("fn:"));
      setSubflowDefs(
        subflows.map((n) => ({
          name: n.name,
          typeId: n.typeId,
          category: n.category,
          description: n.description ?? "",
          inputs: n.inputs ?? [],
          outputs: n.outputs ?? [],
        })),
      );
    }).catch(() => {
      // list_node_types not available or failed — ignore
    });
  }, [projectPath, flowFilename, nodeCatalogVersion]);

  // Build palette entries from WASM plugin nodes
  const pluginPaletteEntries = useMemo<NodeTypeDef[]>(
    () =>
      pluginDefs.map((def) => ({
        type: "pluginNode",
        label: def.name,
        category: (def.category || "Plugins") as NodeCategory,
        description: def.description || `WASM plugin: ${def.typeId}`,
        component: PluginNode,
        hasExecIn: true,
        hasExecOut: true,
        hasDataIn: def.inputs.length > 0,
        hasDataOut: def.outputs.length > 0,
        defaultExecInPin: "exec-in",
        acceptsDataInput: () => true,
        defaultData: () => ({ _pluginDef: def }),
      })),
    [pluginDefs],
  );

  // Build palette entries from project subflows
  const subflowPaletteEntries = useMemo<NodeTypeDef[]>(
    () =>
      subflowDefs.map((def) => {
        const hasExecIn = def.inputs.some((p) => p.dataType === "exec");
        const hasExecOut = def.outputs.some((p) => p.dataType === "exec");
        const dataIn = def.inputs.filter((p) => p.dataType !== "exec");
        const dataOut = def.outputs.filter((p) => p.dataType !== "exec");
        return {
          type: "subflowCall",
          label: def.name,
          category: (def.category || "Project") as NodeCategory,
          description: def.description || `Subflow: ${def.name}`,
          component: SubflowCallNode,
          hasExecIn,
          hasExecOut,
          hasDataIn: dataIn.length > 0,
          hasDataOut: dataOut.length > 0,
          defaultExecInPin: hasExecIn
            ? `exec-in:${def.inputs.find((p) => p.dataType === "exec")!.key}`
            : undefined,
          acceptsDataInput: () => true,
          defaultData: () => ({ _subflowDef: def }),
        };
      }),
    [subflowDefs],
  );

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

  // ── Load flow on flowFilename / projectPath change ─────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    justLoadedRef.current = true;
    hasLoadedRef.current = false;

    void invoke<{
      nodes: unknown[];
      edges: unknown[];
      variables?: FlowVariable[];
      viewport?: { x: number; y: number; zoom: number };
      interface?: Interface | null;
      kind?: string | null;
      groups?: GroupMeta[] | null;
    } | null>("get_flow", { projectPath, filename: flowFilename }).then((flow) => {
      if (cancelled || !flow) return;
      const domainNodes = (flow.nodes as DomainNode[]) ?? [];
      const domainEdges = (flow.edges as DomainEdge[]) ?? [];
      setNodes(domainNodes.map(domainToRf));
      setEdges(domainEdges.map(domainEdgeToRf));
      setVariables((flow.variables as FlowVariable[]) ?? []);
      setFlowInterface(flow.interface ?? null);
      setGroups(flow.groups ?? []);

      // Restore saved viewport or fit. We use a timeout to let React
      // Flow fully process the new nodes before manipulating the viewport.
      const vp = flow.viewport;
      const hasSavedViewport = vp && typeof vp.x === "number" && typeof vp.zoom === "number";
      if (hasSavedViewport) {
        viewportRef.current = vp;
      }

      hasLoadedRef.current = true;
      setLoading(false);

      // Delay viewport restore so React Flow has time to measure nodes.
      // The 300ms animation smooths the transition instead of a jarring snap.
      setTimeout(() => {
        if (cancelled) return;
        if (hasSavedViewport) {
          reactFlow.setViewport(vp, { duration: 300 });
        } else {
          reactFlow.fitView({ padding: 0.35, duration: 300 });
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
        void invoke("save_flow", {
          projectPath,
          filename: flowFilename,
          nodes: nodesRef.current.map(rfToDomain),
          edges: edgesRef.current.map(rfEdgeToDomain),
          viewport: viewportRef.current,
          variables: variablesRef.current,
          interface: interfaceRef.current ?? null,
          groups: groupsRef.current.length > 0 ? groupsRef.current : null,
        });
      }
    };
  }, [projectPath, flowFilename, reactFlow]);

  // ── Debounced autosave (nodes + edges + variables + viewport) ──────────
  // Fires on node/edge/variable changes AND on viewport changes (via viewportTick).
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
      void invoke("save_flow", {
        projectPath,
        filename: flowFilename,
        nodes: domainNodes,
        edges: domainEdges,
        viewport: viewportRef.current,
        variables,
        interface: flowInterface ?? null,
        groups: groups.length > 0 ? groups : null,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [nodes, edges, variables, flowInterface, groups, viewportTick, projectPath, flowFilename, loading]);

  // ── React Flow handlers ────────────────────────────────────
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Split changes: group-placeholder changes update `groups` state;
      // phantom node changes are discarded entirely (they're synthetic,
      // not part of persisted state); the rest update the node list.
      const groupChanges: NodeChange[] = [];
      const normalChanges: NodeChange[] = [];
      for (const ch of changes) {
        const id = (ch as unknown as { id?: string }).id;
        if (id && id.startsWith("group:")) {
          groupChanges.push(ch);
        } else if (id === "phantom-inputs" || id === "phantom-outputs") {
          // Ignore — phantoms are drill-down scaffolding only
          continue;
        } else {
          normalChanges.push(ch);
        }
      }

      if (normalChanges.length > 0) {
        setNodes((nds) => applyNodeChanges(normalChanges, nds));
      }

      for (const ch of groupChanges) {
        // Apply position on every frame (including mid-drag) so the
        // synthetic node doesn't snap back to the memoized `groups[i]`
        // position and produce jitter. Autosave is debounced separately.
        if (ch.type === "position" && ch.position) {
          const gid = (ch as unknown as { id: string }).id.replace(/^group:/, "");
          const pos = ch.position;
          setGroups((gs) =>
            gs.map((g) => (g.id === gid ? { ...g, position: { x: pos.x, y: pos.y } } : g)),
          );
        }
      }

      // Bubble selection for normal nodes so the inspector reacts.
      for (const ch of normalChanges) {
        if (ch.type === "select") {
          if (ch.selected) {
            setSelectedGroupId(null);
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

      // Synthetic group placeholders are derived nodes, so keep their
      // selection separately and feed it back into applyGroups().
      for (const ch of groupChanges) {
        if (ch.type !== "select") continue;
        const gid = (ch as unknown as { id: string }).id.replace(/^group:/, "");
        if (ch.selected) {
          setSelectedGroupId(gid);
          onSelectionChange(null);
        } else {
          setSelectedGroupId((prev) => (prev === gid ? null : prev));
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
          setEdges((eds) => cullDanglingEdges(eds, latestNodes, {
            variables: variablesRef.current,
            flowInterface: interfaceRef.current,
          }));
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

  useEffect(() => {
    if (loading || nodes.length === 0) return;
    setEdges((eds) => cullDanglingEdges(eds, nodes, { variables, flowInterface }));
  }, [flowInterface, loading, nodes, variables]);

  const deleteNode = useCallback((id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedGroupId(null);
    onSelectionChange(null);
  }, [onSelectionChange]);

  // Expose those callbacks to the parent so the inspector can drive them.
  useEffect(() => registerUpdateNodeData(updateNodeData), [registerUpdateNodeData, updateNodeData]);
  useEffect(() => registerDeleteNode(deleteNode), [registerDeleteNode, deleteNode]);
  useEffect(() => registerSetVariables?.(setVariables), [registerSetVariables]);

  // Notify parent of interface changes + register push-setter for Inspector.
  useEffect(() => {
    onInterfaceChange?.(flowInterface);
  }, [flowInterface, onInterfaceChange]);
  useEffect(
    () => registerSetInterface?.((iface) => setFlowInterface(iface)),
    [registerSetInterface],
  );

  // Active env = the one selected on the Start node. The Start node stores
  // the env filename (e.g. "production.env.json") in data.environmentFilename.
  // Recomputes whenever the user changes the dropdown.
  const activeEnvironment = useMemo(() => {
    const startNode = nodes.find((n) => n.type === "start");
    const envFilename = (startNode?.data as { environmentFilename?: string } | undefined)?.environmentFilename;
    if (!envFilename) return null;
    return environments.find((e) => e.filename === envFilename) ?? null;
  }, [nodes, environments]);

  // Pre-flight validation: walks every node, returns the first reason the
  // flow can't run (or null if it can). The Start node uses this to disable
  // the Run button and show a tooltip.
  const validation = useMemo(
    () => validateFlow(nodes, edges, activeEnvironment),
    [nodes, edges, activeEnvironment],
  );

  // ── Flow execution (Rust executor via Tauri IPC) ───────────
  const run = useCallback(() => {
    if (running) return;
    const check = validateFlow(nodesRef.current, edgesRef.current, activeEnvironment);
    if (!check.canRun) {
      console.warn("[runFlow] blocked:", check.reason);
      return;
    }
    setStatuses({});
    setResults({});
    setErrors({});
    setRawResponses({});

    // Resolve the active environment from the Start node's config
    const startNode = nodesRef.current.find((n) => n.type === "start");
    const envFilename = (startNode?.data as { environmentFilename?: string } | undefined)?.environmentFilename;
    const env = environments.find((e) => e.filename === envFilename);
    const envVars: Record<string, unknown> = {};
    for (const v of env?.vars ?? []) {
      envVars[v.key] = v.value;
    }

    // Build variable declarations for the executor's pre-seeding
    const variableDecls = variablesRef.current.map((v) => ({
      name: v.name,
      type: v.type,
      default: v.default,
    }));

    const context = {
      envVars,
      variables: variableDecls,
    };

    // Invoke — event listeners are always-on (see useEffect above)
    void invoke("run_flow", {
      flowId: flowFilename,
      projectPath,
      nodes: nodesRef.current,
      edges: edgesRef.current,
      context,
    }).catch((err) => console.error("[runFlow]", err));
  }, [running, projectPath, flowFilename, environments, activeEnvironment]);

  const stop = useCallback(() => {
    void invoke("stop_flow", { flowId: flowFilename });
  }, [flowFilename]);

  // ── Build flow to binary ──────────────────────────────────────
  const [building, setBuilding] = useState(false);
  const [buildStatus, setBuildStatus] = useState<{
    stage: "idle" | "preparing" | "compiling" | "done" | "error";
    message: string;
  }>({ stage: "idle", message: "" });

  const buildFlow = useCallback(async () => {
    if (building || !projectPath || !flowFilename) return;

    // Pick output location
    const outputPath = await saveDialog({
      title: "Save Binary As",
      defaultPath: flowFilename.replace(".flow.json", "").replace(".json", ""),
    });
    if (!outputPath) return;

    setBuilding(true);
    setBuildStatus({ stage: "preparing", message: "Preparing build..." });

    // Listen for progress events
    const unlisten = await listen<{ stage: string; message: string }>("build:progress", (e) => {
      setBuildStatus({
        stage: e.payload.stage as "preparing" | "compiling" | "done" | "error",
        message: e.payload.message,
      });
    });

    try {
      // Get active env name
      const startNode = nodesRef.current.find((n) => n.type === "start");
      const envFilename = (startNode?.data as { environmentFilename?: string })?.environmentFilename;
      const envName = envFilename === ".env" ? "default"
        : envFilename?.replace(".env.", "") ?? "default";

      await invoke("build_flow", {
        projectPath,
        flowFilename,
        envName,
        outputPath,
      });
    } catch (err) {
      setBuildStatus({ stage: "error", message: String(err) });
    } finally {
      unlisten();
      setBuilding(false);
      // Auto-hide success after 5s
      setTimeout(() => {
        setBuildStatus((prev) => prev.stage === "done" ? { stage: "idle", message: "" } : prev);
      }, 5000);
    }
  }, [building, projectPath, flowFilename]);

  const execContextValue = useMemo<FlowExecContextValue>(
    () => ({
      run,
      stop,
      statuses,
      results,
      errors,
      running,
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

  useEffect(() => {
    registerOpenPalette?.(openPaletteAtCenter);
  }, [registerOpenPalette, openPaletteAtCenter]);

  useEffect(() => {
    registerBuildFlow?.(() => void buildFlow());
  }, [registerBuildFlow, buildFlow]);

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

  const variablesContextValue = useMemo(
    () => ({ variables, setVariables }),
    [variables],
  );

  const interfaceContextValue = useMemo(
    () => ({ interface: flowInterface, setInterface: setFlowInterface }),
    [flowInterface],
  );

  // ── Group commands ──────────────────────────────────────────
  const handleCollapseSelection = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    const ids = selected.map((n) => n.id).filter((id) => !id.startsWith("group:"));
    if (ids.length < 2) return;
    // Don't allow grouping nodes that are already in a different group.
    const existingGroups = new Set(
      selected
        .map((n) => (n.data as { groupId?: string } | undefined)?.groupId)
        .filter(Boolean),
    );
    if (existingGroups.size > 1) return;

    const label = `Group ${groups.length + 1}`;
    const { nodes: nextNodes, group } = createGroup(nodes, ids, label);
    setNodes(nextNodes);
    setGroups([...groups, group]);
  }, [nodes, groups, setNodes]);

  const handleUngroup = useCallback((groupId: string) => {
    const { nodes: nextNodes, groups: nextGroups } = ungroupOp(nodes, groups, groupId);
    setNodes(nextNodes);
    setGroups(nextGroups);
    if (focusedGroupId === groupId) setFocusedGroupId(null);
  }, [nodes, groups, focusedGroupId, setNodes]);

  const handleExpand = useCallback((groupId: string) => {
    setGroups((gs) => toggleCollapsed(gs, groupId));
  }, []);

  const handleRename = useCallback((groupId: string, label: string) => {
    setGroups((gs) => renameGroup(gs, groupId, label));
  }, []);

  const groupCallbacks = useMemo<GroupNodeCallbacks>(
    () => ({ onUngroup: handleUngroup, onExpand: handleExpand, onRename: handleRename }),
    [handleUngroup, handleExpand, handleRename],
  );

  // ── Apply group transform before handing nodes/edges to React Flow ──
  const { renderedNodes, renderedEdges } = useMemo(() => {
    const { nodes: n, edges: e } = applyGroups(
      nodes,
      edges,
      groups,
      selectedGroupId,
      focusedGroupId,
    );
    return { renderedNodes: n, renderedEdges: e };
  }, [nodes, edges, groups, selectedGroupId, focusedGroupId]);

  // ── Double-click: drill into group OR navigate to subflow file ──
  const [subflowNameToFilename, setSubflowNameToFilename] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!projectPath) return;
    void invoke<Array<{ filename: string; name: string; kind?: string }>>("list_flows", {
      projectPath,
    }).then((list) => {
      const map: Record<string, string> = {};
      for (const f of list) {
        if (f.kind === "subflow") map[f.name] = f.filename;
      }
      setSubflowNameToFilename(map);
    }).catch(() => {});
  }, [projectPath, flowFilename]);

  // Group drill-down — runs from React Flow's event system since the group
  // placeholder doesn't have its own internal click handler.
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === GROUP_NODE_TYPE) {
        const gid = (node.data as { _groupId?: string } | undefined)?._groupId;
        if (gid) setFocusedGroupId(gid);
      }
    },
    [],
  );

  // Subflow navigation — called directly from SubflowCallNode via context
  // (bypassing React Flow's event dispatch). Looks up the filename live in
  // `list_flows` so we never hit a stale cache.
  const navigateToSubflow = useCallback(
    (name: string) => {
      if (!projectPath) return;
      const cached = subflowNameToFilename[name];
      if (cached) {
        onSelectFlow(cached);
        return;
      }
      void invoke<Array<{ filename: string; name: string; kind?: string }>>(
        "list_flows",
        { projectPath },
      )
        .then((list) => {
          const match = list.find((f) => f.kind === "subflow" && f.name === name);
          if (match) onSelectFlow(match.filename);
          else console.warn(`[subflow nav] '${name}' not found in project`);
        })
        .catch((e) => console.error("[subflow nav] list_flows failed", e));
    },
    [projectPath, subflowNameToFilename, onSelectFlow],
  );

  // ── Keyboard: Cmd/Ctrl+G collapse selection, Shift+Cmd/Ctrl+G ungroup ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;

      if ((e.metaKey || e.ctrlKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (e.shiftKey) {
          // Ungroup: find a selected group placeholder OR a member of a group
          const selected = nodes.find((n) => n.selected);
          let gid: string | undefined;
          if (selectedGroupId) {
            gid = selectedGroupId;
          } else if (!selected) {
            return;
          } else if (selected.type === GROUP_NODE_TYPE) {
            gid = (selected.data as { _groupId?: string } | undefined)?._groupId;
          } else {
            gid = (selected.data as { groupId?: string } | undefined)?.groupId;
          }
          if (gid) handleUngroup(gid);
        } else {
          handleCollapseSelection();
        }
      }

      // Escape exits drill-down
      if (e.key === "Escape" && focusedGroupId) {
        setFocusedGroupId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, selectedGroupId, focusedGroupId, handleCollapseSelection, handleUngroup]);

  return (
    <FlowVariablesContext.Provider value={variablesContextValue}>
    <FlowInterfaceContext.Provider value={interfaceContextValue}>
    <FlowExecContext.Provider value={execContextValue}>
      <div className={s.canvas}>
        {/* Build progress overlay */}
        {buildStatus.stage !== "idle" && (
          <div className={s.buildOverlay}>
            <div className={`${s.buildCard} ${
              buildStatus.stage === "error" ? s.buildError :
              buildStatus.stage === "done" ? s.buildDone : ""
            }`}>
              {buildStatus.stage === "compiling" && <div className={s.buildSpinner} />}
              {buildStatus.stage === "done" && <span className={s.buildIcon}>✓</span>}
              {buildStatus.stage === "error" && <span className={s.buildIcon}>✗</span>}
              <span className={s.buildMessage}>{buildStatus.message}</span>
              {(buildStatus.stage === "done" || buildStatus.stage === "error") && (
                <button
                  className={s.buildDismiss}
                  onClick={() => setBuildStatus({ stage: "idle", message: "" })}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}

        {focusedGroupId && (
          <div className={s.breadcrumb}>
            <button
              className={s.breadcrumbRoot}
              onClick={() => setFocusedGroupId(null)}
              title="Back to the full flow"
            >
              {flowFilename?.replace(/\.flow\.json$/, "") ?? "flow"}
            </button>
            <span className={s.breadcrumbSep}>›</span>
            <span className={s.breadcrumbCurrent}>
              {groups.find((g) => g.id === focusedGroupId)?.label ?? "Group"}
            </span>
            <button
              className={s.breadcrumbExit}
              onClick={() => setFocusedGroupId(null)}
              title="Exit drill-down (Esc)"
            >
              ×
            </button>
          </div>
        )}

        <SubflowNavContext.Provider value={navigateToSubflow}>
        <GroupCallbacksContext.Provider value={groupCallbacks}>
        <ReactFlow
          nodes={renderedNodes}
          edges={renderedEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onPaneContextMenu={onPaneContextMenu}
          onMoveEnd={onMoveEnd}
          onNodeDoubleClick={onNodeDoubleClick}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="rgba(255,255,255,0.05)" />
          <Controls className={s.controls} position="top-left" />
          {loading && <div className={s.spinner} />}
          {showMinimap && <MiniMap pannable zoomable className={s.minimap} />}
        </ReactFlow>
        </GroupCallbacksContext.Provider>
        </SubflowNavContext.Provider>


        {palette && (
          <NodePalette
            position={palette.screenPos}
            extraNodes={[...customPaletteEntries, ...pluginPaletteEntries, ...subflowPaletteEntries]}
            title={
              palette.pendingConnection
                ? palette.pendingConnection.sourceKind === "exec"
                  ? "Add exec node"
                  : `Add node accepting ${palette.pendingConnection.sourceDataType ?? "value"}`
                : "Add Node"
            }
            filter={(def) => {
              // Always hide explicitly-hidden node types (e.g. subflow I/O)
              if (def.hidden) return false;
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
    </FlowInterfaceContext.Provider>
    </FlowVariablesContext.Provider>
  );
}

// ─── Domain ↔ React Flow translators ───────────────────────────

function domainToRf(n: DomainNode): Node {
  let type = kindToType(n.kind);
  // Unknown kind + has _pluginDef → it's a WASM plugin node
  if (!KNOWN_TYPES.has(n.kind) && n.config?._pluginDef) {
    type = "pluginNode";
  }
  // `fn:<name>` → subflow call node
  if (n.kind.startsWith("fn:")) {
    type = "subflowCall";
  }
  return {
    id: n.id,
    type,
    position: n.position,
    data: (n.config ?? {}) as Record<string, unknown>,
  };
}

function rfToDomain(n: Node): DomainNode {
  const data = (n.data ?? {}) as Record<string, unknown>;
  // Plugin nodes: store the actual plugin typeId as kind, not "pluginNode"
  let kind = typeToKind(n.type ?? "httpRequest");
  if (n.type === "pluginNode") {
    const pluginDef = data._pluginDef as { typeId?: string } | undefined;
    kind = pluginDef?.typeId ?? "pluginNode";
  }
  if (n.type === "subflowCall") {
    const def = data._subflowDef as { typeId?: string } | undefined;
    kind = def?.typeId ?? "subflowCall";
  }
  return {
    id: n.id,
    kind,
    position: { x: n.position.x, y: n.position.y },
    config: data,
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
  "setVariable",
  "getVariable",
  "emitEvent",
  "onEvent",
  "assert",
  "assertType",
  "ifElse",
  "tryCatch",
  "httpListen",
  "sendResponse",
  "routeMatch",
  "print",
  "shellExec",
  "fileRead",
  "fileWrite",
  "sleep",
  "exit",
  "customNode",
  "pluginNode",
  // CLI
  "parseArgs",
  "stdin",
  "stderr",
  "prompt",
  // String
  "regex",
  "template",
  "encodeDecode",
  "hash",
  // Data transform
  "filter",
  "map",
  "merge",
  "reduce",
  // Flow control
  "retry",
  // HTTP Server (new)
  "route",
  "parseBody",
  "setHeaders",
  "cors",
  "verifyAuth",
  "rateLimit",
  "cookie",
  "redirect",
  "serveStatic",
  // Subflow I/O
  "subflowInputs",
  "subflowOutputs",
  "subflowCall",
  // Collapsed-group placeholder — synthetic, never persisted as a node
  "collapsedGroup",
]);

function kindToType(kind: string): string {
  return KNOWN_TYPES.has(kind) ? kind : "httpRequest";
}

function typeToKind(type: string): string {
  return KNOWN_TYPES.has(type) ? type : "httpRequest";
}
