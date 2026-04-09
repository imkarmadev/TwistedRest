/**
 * Shared mapping from DataType → CSS module class name for pin coloring.
 *
 * Previously duplicated in every node component file (~16 lines × 8 files).
 * Import this instead of redeclaring per-component.
 *
 * Usage:
 *   import { pinClass } from "../../lib/pin-classes";
 *   <Handle className={`${s.pin} ${pinClass(s, "number")}`} />
 */

import type { DataType } from "@twistedrest/core";

const TYPE_TO_CLASS: Record<DataType, string> = {
  string: "pinString",
  number: "pinNumber",
  boolean: "pinBoolean",
  object: "pinObject",
  array: "pinArray",
  null: "pinObject",
  unknown: "pinObject",
};

/**
 * Look up the CSS module class name for a given data type.
 * `styles` is the imported CSS module object from node.module.css.
 */
export function pinClass(
  styles: Record<string, string>,
  type: DataType | string | undefined,
): string {
  const key = TYPE_TO_CLASS[(type ?? "unknown") as DataType] ?? "pinObject";
  return styles[key] ?? "";
}
