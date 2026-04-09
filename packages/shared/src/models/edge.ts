import { z } from "zod";

/**
 * Two distinct edge kinds, just like Unreal Blueprints:
 *
 * - `exec` edges carry control flow. Drawn white/thick. Always connect
 *   an exec output pin → an exec input pin. Determines run order.
 *
 * - `data` edges carry typed values. Drawn in colors based on type.
 *   Connect a node's output data pin → another node's input data pin.
 */
export const EdgeKind = z.enum(["exec", "data"]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const FlowEdge = z.object({
  id: z.string().uuid(),
  kind: EdgeKind,
  fromNode: z.string().uuid(),
  fromPin: z.string(),
  toNode: z.string().uuid(),
  toPin: z.string(),
});
export type FlowEdge = z.infer<typeof FlowEdge>;
