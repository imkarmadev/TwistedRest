import { z } from "zod";
import { FlowNode } from "./node.js";
import { FlowEdge } from "./edge.js";

/**
 * A Flow is a single graph/canvas inside a project.
 * Stores its own nodes and edges (not normalized into separate tables —
 * a flow is the unit of save and the unit of execution).
 */
export const Flow = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  nodes: z.array(FlowNode).default([]),
  edges: z.array(FlowEdge).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().default(null),
});
export type Flow = z.infer<typeof Flow>;
