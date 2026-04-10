/**
 * Pin descriptors used by the canvas to render sockets and by the executor
 * to wire data between nodes.
 *
 * `kind: "exec"` pins are control-flow sockets (white diamond edges).
 * `kind: "data"` pins carry typed values (colored circle edges).
 */

export type DataType =
  | "unknown"
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface PinDescriptor {
  /** Stable identifier within the node (e.g. "exec", "out", "user", "url"). */
  id: string;
  kind: "exec" | "data";
  direction: "in" | "out";
  /** Display label. */
  label: string;
  /** For data pins only. */
  dataType?: DataType;
  /** For object/array data pins, the inner schema (used by Break-Object). */
  inner?: unknown;
}
