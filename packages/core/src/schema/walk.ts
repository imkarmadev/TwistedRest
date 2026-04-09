import { z, type ZodTypeAny } from "zod";
import type { DataType, PinDescriptor } from "../pins.js";

/**
 * Walk a Zod schema and emit one *top-level* output pin per field.
 *
 * Object pins surface as a single `object` pin with `inner` set to the
 * nested schema, so the canvas can render the "object" icon and the user
 * can drop a Break-Object node to expand sub-fields (UE Blueprint style).
 *
 * Arrays surface as `array` pins with `inner` set to the element schema —
 * iterator nodes (ForEach) consume these.
 */
export function pinsFromSchema(schema: ZodTypeAny): PinDescriptor[] {
  const def = schema._def;

  // Top-level object → one pin per key
  if (def?.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    return Object.entries(shape).map(([key, child]) => describePin(key, child as ZodTypeAny));
  }

  // Anything else → single anonymous output
  return [describePin("value", schema)];
}

function describePin(id: string, schema: ZodTypeAny): PinDescriptor {
  const { type, inner } = classify(schema);
  return {
    id,
    kind: "data",
    direction: "out",
    label: id,
    dataType: type,
    inner,
  };
}

function classify(schema: ZodTypeAny): { type: DataType; inner?: unknown } {
  // Unwrap Optional/Nullable/Default
  let cur: ZodTypeAny = schema;
  while (
    cur._def?.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
    cur._def?.typeName === z.ZodFirstPartyTypeKind.ZodNullable ||
    cur._def?.typeName === z.ZodFirstPartyTypeKind.ZodDefault
  ) {
    cur = cur._def.innerType ?? cur._def.schema;
  }

  const tn = cur._def?.typeName;
  switch (tn) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: "string" };
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: "number" };
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodNull:
      return { type: "null" };
    case z.ZodFirstPartyTypeKind.ZodObject:
      return { type: "object", inner: cur };
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", inner: (cur as z.ZodArray<ZodTypeAny>)._def.type };
    default:
      return { type: "unknown" };
  }
}
