/**
 * Collapsed-group helpers.
 *
 * A group is a **purely visual** folding of N canvas nodes into one
 * placeholder. The engine doesn't know groups exist — when the flow runs,
 * the executor sees a flat graph. Groups are tracked via:
 *
 *   - `data.groupId?: string` on each member node
 *   - top-level `groups: GroupMeta[]` in flow JSON
 *
 * When a group is collapsed, we:
 *   1. Hide its member nodes from the canvas
 *   2. Inject a synthetic "group" node at `group.position`
 *   3. For every edge where exactly one endpoint is a member, rewrite that
 *      endpoint to the placeholder with a derived pin id — that way the
 *      placeholder shows labeled boundary pins exactly where the original
 *      pins sat.
 *
 * When drill-down is active, we show ONLY the target group's members and
 * the edges between them, nothing else.
 */

import type { Node, Edge } from "@xyflow/react";

export interface GroupMeta {
  id: string;
  label: string;
  collapsed: boolean;
  position: { x: number; y: number };
}

export const GROUP_NODE_TYPE = "collapsedGroup";
/** Synthetic phantom node shown on either side of the drill-down canvas,
 *  exposing the boundary pins of the group so the user can see exactly
 *  what's coming in from outside / going out. Rendered by PhantomBoundaryNode. */
export const PHANTOM_INPUTS_TYPE = "phantomInputs";
export const PHANTOM_OUTPUTS_TYPE = "phantomOutputs";
// Plain IDs — avoid double-underscore prefixes which some graph libs strip.
export const PHANTOM_INPUTS_ID = "phantom-inputs";
export const PHANTOM_OUTPUTS_ID = "phantom-outputs";

/** Boundary pin on the placeholder — derived from an edge crossing in or out. */
export interface BoundaryPin {
  /** Handle id unique on the placeholder, e.g. "b_in_n1_exec-in". */
  id: string;
  side: "left" | "right";
  label: string;
  /** "exec" for white diamond; data type hint for coloring. */
  kind: "exec" | "data";
  dataType?: string;
}

export interface GroupRenderResult {
  /** Nodes to render: non-members + synthetic placeholders for collapsed groups. */
  nodes: Node[];
  /** Edges with boundary-crossing endpoints re-routed to placeholder handles. */
  edges: Edge[];
  /** Per-group boundary pins (for the placeholder to render). */
  boundaryPinsByGroup: Record<string, BoundaryPin[]>;
}

/**
 * Core transform. Takes raw nodes + edges + group metadata; returns the
 * filtered + rerouted view ready to hand to React Flow.
 *
 * If `focusedGroupId` is non-null, operates in drill-down mode: show only
 * members of that group + their internal edges. All other nodes/edges
 * hidden. Ignores `collapsed` state.
 */
export function applyGroups(
  rawNodes: Node[],
  rawEdges: Edge[],
  groups: GroupMeta[],
  selectedGroupId: string | null = null,
  focusedGroupId: string | null = null,
): GroupRenderResult {
  // ── Drill-down mode: show only focused group's internals + phantoms ──
  if (focusedGroupId) {
    const memberIds = new Set(
      rawNodes
        .filter((n) => (n.data as { groupId?: string } | undefined)?.groupId === focusedGroupId)
        .map((n) => n.id),
    );
    const memberNodes = rawNodes.filter((n) => memberIds.has(n.id));

    // Split edges into internal (both endpoints are members) and boundary
    // (one endpoint outside the group). Boundary edges get rewired to
    // phantom Inputs/Outputs nodes placed at the edges of the view.
    const internalEdges: Edge[] = [];
    const inboundPins: BoundaryPin[] = []; // things coming INTO members from outside
    const outboundPins: BoundaryPin[] = []; // things leaving members to outside
    const rewiredEdges: Edge[] = [];

    for (const e of rawEdges) {
      const srcMember = memberIds.has(e.source);
      const tgtMember = memberIds.has(e.target);
      if (srcMember && tgtMember) {
        internalEdges.push(e);
        continue;
      }
      if (!srcMember && !tgtMember) continue; // unrelated, drop

      const kind = (e.data as { kind?: "exec" | "data" } | undefined)?.kind ?? "data";

      if (!srcMember && tgtMember) {
        // External → member : phantom Inputs node on the left exposes this
        const pinId = `p_in_${e.source}_${e.sourceHandle ?? "default"}`;
        inboundPins.push({
          id: pinId,
          side: "right",
          label: originLabel(rawNodes, e.source, e.sourceHandle),
          kind,
        });
        rewiredEdges.push({
          ...e,
          source: PHANTOM_INPUTS_ID,
          sourceHandle: pinId,
        });
      } else if (srcMember && !tgtMember) {
        // Member → external : phantom Outputs node on the right receives it
        const pinId = `p_out_${e.target}_${e.targetHandle ?? "default"}`;
        outboundPins.push({
          id: pinId,
          side: "left",
          label: originLabel(rawNodes, e.target, e.targetHandle),
          kind,
        });
        rewiredEdges.push({
          ...e,
          target: PHANTOM_OUTPUTS_ID,
          targetHandle: pinId,
        });
      }
    }

    const extremaX = memberNodes.length
      ? {
          minX: Math.min(...memberNodes.map((n) => n.position.x)),
          maxX: Math.max(...memberNodes.map((n) => n.position.x)),
          midY:
            memberNodes.reduce((s, n) => s + n.position.y, 0) / memberNodes.length,
        }
      : { minX: 0, maxX: 400, midY: 200 };

    const phantomNodes: Node[] = [];
    if (inboundPins.length > 0) {
      phantomNodes.push({
        id: PHANTOM_INPUTS_ID,
        type: PHANTOM_INPUTS_TYPE,
        position: { x: extremaX.minX - 320, y: extremaX.midY - 40 },
        data: { _pins: inboundPins, _label: "Inputs (from outside)" },
      });
    }
    if (outboundPins.length > 0) {
      phantomNodes.push({
        id: PHANTOM_OUTPUTS_ID,
        type: PHANTOM_OUTPUTS_TYPE,
        position: { x: extremaX.maxX + 320, y: extremaX.midY - 40 },
        data: { _pins: outboundPins, _label: "Outputs (to outside)" },
      });
    }

    return {
      nodes: [...memberNodes, ...phantomNodes],
      edges: [...internalEdges, ...rewiredEdges],
      boundaryPinsByGroup: {},
    };
  }

  // ── Normal mode: collapse groups marked collapsed ─────────────────
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const collapsedGroups = new Set(groups.filter((g) => g.collapsed).map((g) => g.id));

  const memberToGroup = new Map<string, string>();
  for (const n of rawNodes) {
    const gid = (n.data as { groupId?: string } | undefined)?.groupId;
    if (gid && collapsedGroups.has(gid)) {
      memberToGroup.set(n.id, gid);
    }
  }

  // Nodes: keep non-members, hide members of collapsed groups.
  const nodes: Node[] = rawNodes.filter((n) => !memberToGroup.has(n.id));

  // Inject one synthetic placeholder per collapsed group.
  // Also pre-init the boundary pin map so GroupNode can read it.
  const boundaryPinsByGroup: Record<string, BoundaryPin[]> = {};
  for (const gid of collapsedGroups) {
    const g = groupById.get(gid);
    if (!g) continue;
    boundaryPinsByGroup[gid] = [];
    nodes.push({
      id: `group:${gid}`,
      type: GROUP_NODE_TYPE,
      position: g.position,
      selected: gid === selectedGroupId,
      data: {
        _groupId: gid,
        _label: g.label,
        // boundary pins are populated just below once edges are scanned
      },
    });
  }

  // Edges: rewrite boundary-crossing endpoints to the placeholder.
  const edges: Edge[] = [];
  for (const e of rawEdges) {
    const srcGroup = memberToGroup.get(e.source);
    const tgtGroup = memberToGroup.get(e.target);

    // Fully internal to one collapsed group → drop (hidden under placeholder)
    if (srcGroup && srcGroup === tgtGroup) continue;

    if (!srcGroup && !tgtGroup) {
      // Fully external — pass through
      edges.push(e);
      continue;
    }

    // Crossing edge: rewrite the endpoint inside a collapsed group
    const kind = (e.data as { kind?: "exec" | "data" } | undefined)?.kind ?? "data";
    let source = e.source;
    let sourceHandle = e.sourceHandle;
    let target = e.target;
    let targetHandle = e.targetHandle;

    if (srcGroup) {
      const pinId = `b_out_${e.source}_${e.sourceHandle ?? "default"}`;
      source = `group:${srcGroup}`;
      sourceHandle = pinId;
      registerBoundary(boundaryPinsByGroup, srcGroup, {
        id: pinId,
        side: "right",
        label: originLabel(rawNodes, e.source, e.sourceHandle),
        kind,
      });
    }
    if (tgtGroup) {
      const pinId = `b_in_${e.target}_${e.targetHandle ?? "default"}`;
      target = `group:${tgtGroup}`;
      targetHandle = pinId;
      registerBoundary(boundaryPinsByGroup, tgtGroup, {
        id: pinId,
        side: "left",
        label: originLabel(rawNodes, e.target, e.targetHandle),
        kind,
      });
    }

    edges.push({
      ...e,
      source,
      sourceHandle: sourceHandle ?? undefined,
      target,
      targetHandle: targetHandle ?? undefined,
    });
  }

  // Merge boundary pins back into the synthetic placeholder node data so
  // GroupNode can render them.
  for (const n of nodes) {
    if (n.type === GROUP_NODE_TYPE) {
      const gid = (n.data as { _groupId: string })._groupId;
      (n.data as Record<string, unknown>)._boundaryPins = boundaryPinsByGroup[gid] ?? [];
    }
  }

  return { nodes, edges, boundaryPinsByGroup };
}

function registerBoundary(
  map: Record<string, BoundaryPin[]>,
  gid: string,
  pin: BoundaryPin,
) {
  const list = map[gid];
  if (!list) return;
  if (list.some((p) => p.id === pin.id)) return;
  list.push(pin);
}

/** Human-readable label for a boundary pin, e.g. "HttpRequest › status". */
function originLabel(nodes: Node[], nodeId: string, handle: string | null | undefined): string {
  const node = nodes.find((n) => n.id === nodeId);
  const nodeLabel = (node?.data as { label?: string } | undefined)?.label ?? node?.type ?? nodeId;
  const pinLabel = (handle ?? "").replace(/^exec-(in|out)$/i, "exec").replace(/^(in|out):/, "");
  return pinLabel ? `${nodeLabel} › ${pinLabel}` : nodeLabel;
}

// ── Mutations ──────────────────────────────────────────────────────

/** Create a new group from the given node ids. Mutates node `data.groupId`. */
export function createGroup(
  nodes: Node[],
  selectedIds: string[],
  label = "Group",
): { nodes: Node[]; group: GroupMeta } {
  const id = `g_${Math.random().toString(36).slice(2, 10)}`;

  // Centroid of selection → placeholder position
  const selected = nodes.filter((n) => selectedIds.includes(n.id));
  const cx = selected.reduce((s, n) => s + n.position.x, 0) / Math.max(1, selected.length);
  const cy = selected.reduce((s, n) => s + n.position.y, 0) / Math.max(1, selected.length);

  const nextNodes = nodes.map((n) =>
    selectedIds.includes(n.id)
      ? { ...n, data: { ...(n.data ?? {}), groupId: id } }
      : n,
  );

  const group: GroupMeta = {
    id,
    label,
    collapsed: true,
    position: { x: cx, y: cy },
  };

  return { nodes: nextNodes, group };
}

/** Dissolve a group: strip `groupId` from members; drop the group entry. */
export function ungroup(
  nodes: Node[],
  groups: GroupMeta[],
  groupId: string,
): { nodes: Node[]; groups: GroupMeta[] } {
  const nextNodes = nodes.map((n) => {
    const gid = (n.data as { groupId?: string } | undefined)?.groupId;
    if (gid !== groupId) return n;
    const { groupId: _drop, ...rest } = n.data as { groupId?: string; [k: string]: unknown };
    void _drop;
    return { ...n, data: rest };
  });
  return {
    nodes: nextNodes,
    groups: groups.filter((g) => g.id !== groupId),
  };
}

/** Toggle collapsed state of a group. */
export function toggleCollapsed(groups: GroupMeta[], groupId: string): GroupMeta[] {
  return groups.map((g) =>
    g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
  );
}

/** Update a group's label. */
export function renameGroup(
  groups: GroupMeta[],
  groupId: string,
  label: string,
): GroupMeta[] {
  return groups.map((g) => (g.id === groupId ? { ...g, label } : g));
}
