/**
 * Shared schema-resolution helpers used by Break-Object, Convert, and any
 * other node that needs to introspect what's wired to its input.
 *
 * Two functions:
 *
 *   resolveSourcePinSchema  → returns the full Zod schema of a specific
 *                             output pin on a source node. Walks back
 *                             through Break-Object, Convert, ForEach, etc.
 *                             so the caller never has to know the chain.
 *
 *   getSourcePinType        → returns just the simple DataType label
 *                             ("string" | "number" | ...). Cheap variant
 *                             when you only care about coloring or filtering
 *                             a UI dropdown.
 */

import { z, type ZodTypeAny } from "zod";
import type { Node, Edge } from "@xyflow/react";
import type { DataType } from "@twistedflow/core";
import { evalZodSchema } from "./eval-schema";

/**
 * Walk back from a source pin to its underlying Zod schema.
 *
 *   HTTP node       → parse responseSchema, extract the named field
 *   EnvVar node     → always z.string()
 *   ForEach.item    → unwrap one level of z.array() from the array source
 *   ForEach.index   → z.number()
 *   Break-Object    → recursive: walk back to ITS source's object schema,
 *                      extract the named field
 *   Convert         → return the configured target type as a Zod primitive
 *
 * Returns null if the schema can't be resolved at design time.
 */
export function resolveSourcePinSchema(
  sourceNode: Node,
  pinId: string,
  allNodes: Node[],
  allEdges: Edge[],
): ZodTypeAny | null {
  if (sourceNode.type === "httpRequest") {
    const data = (sourceNode.data ?? {}) as { responseSchema?: string };
    const result = evalZodSchema(data.responseSchema ?? "");
    if (!result.ok || !result.schema) return null;
    return extractField(result.schema, pinId);
  }

  if (sourceNode.type === "envVar") {
    return z.string();
  }

  if (sourceNode.type === "forEachSequential" || sourceNode.type === "forEachParallel") {
    if (pinId === "index") return z.number();
    if (pinId === "item") {
      const arrayEdge = allEdges.find(
        (e) => e.target === sourceNode.id && e.targetHandle === "in:array",
      );
      if (!arrayEdge) return null;
      const arraySource = allNodes.find((n) => n.id === arrayEdge.source);
      if (!arraySource) return null;
      const arrayPin = (arrayEdge.sourceHandle ?? "").replace(/^out:/, "");
      const arraySchema = resolveSourcePinSchema(
        arraySource,
        arrayPin,
        allNodes,
        allEdges,
      );
      if (!arraySchema) return null;
      const unwrapped = unwrapOptional(arraySchema);
      const def = unwrapped._def as { typeName?: string; type?: ZodTypeAny };
      if (def?.typeName === z.ZodFirstPartyTypeKind.ZodArray && def.type) {
        return def.type;
      }
      return null;
    }
    return null;
  }

  if (sourceNode.type === "breakObject") {
    const inEdge = allEdges.find(
      (e) => e.target === sourceNode.id && e.targetHandle === "in:object",
    );
    if (!inEdge) return null;
    const upstream = allNodes.find((n) => n.id === inEdge.source);
    if (!upstream) return null;
    const upstreamPin = (inEdge.sourceHandle ?? "").replace(/^out:/, "");
    const upstreamSchema = resolveSourcePinSchema(
      upstream,
      upstreamPin,
      allNodes,
      allEdges,
    );
    if (!upstreamSchema) return null;
    return extractField(upstreamSchema, pinId);
  }

  if (sourceNode.type === "convert") {
    const target = (sourceNode.data as { targetType?: string } | undefined)?.targetType;
    return convertTargetToZod(target);
  }

  if (sourceNode.type === "tap") {
    // Type-transparent: walk back to whatever feeds this Tap and return
    // its schema as-is. Same field name (Tap only has one pin: "value").
    const inEdge = allEdges.find(
      (e) => e.target === sourceNode.id && e.targetHandle === "in:value",
    );
    if (!inEdge) return null;
    const upstream = allNodes.find((n) => n.id === inEdge.source);
    if (!upstream) return null;
    return resolveSourcePinSchema(
      upstream,
      (inEdge.sourceHandle ?? "").replace(/^out:/, ""),
      allNodes,
      allEdges,
    );
  }

  if (sourceNode.type === "makeObject") {
    // Build a z.object from the declared field shape — used by downstream
    // Break-Object nodes to introspect what fields are available.
    const fields =
      ((sourceNode.data as { fields?: Array<{ key: string; type: string }> } | undefined)
        ?.fields) ?? [];
    const shape: Record<string, ZodTypeAny> = {};
    for (const f of fields) {
      if (!f.key) continue;
      shape[f.key] = payloadTypeToZod(f.type);
    }
    return z.object(shape);
  }

  if (sourceNode.type === "function") {
    // Return the Zod type for this specific output pin
    const outputs =
      ((sourceNode.data as { outputs?: Array<{ key: string; type: string }> } | undefined)
        ?.outputs) ?? [];
    const field = outputs.find((o) => o.key === pinId);
    if (field) return payloadTypeToZod(field.type);
    return null;
  }

  // ── HTTP Server nodes: return fixed schemas for known output pins ──
  if (sourceNode.type === "route") {
    if (pinId === "params" || pinId === "query") return z.object({}).passthrough();
    return null;
  }
  if (sourceNode.type === "parseBody") {
    if (pinId === "contentType") return z.string();
    return null; // parsed is unknown
  }
  if (sourceNode.type === "cors") {
    if (pinId === "corsHeaders") return z.object({}).passthrough();
    return null;
  }
  if (sourceNode.type === "verifyAuth") {
    if (pinId === "claims") return z.object({}).passthrough();
    if (pinId === "token") return z.string();
    if (pinId === "error") return z.string();
    return null;
  }
  if (sourceNode.type === "rateLimit") {
    if (pinId === "remaining") return z.number();
    if (pinId === "rateLimitHeaders") return z.object({}).passthrough();
    return null;
  }
  if (sourceNode.type === "cookie") {
    if (pinId === "cookies" || pinId === "setCookieHeaders") return z.object({}).passthrough();
    return null;
  }
  if (sourceNode.type === "setHeaders") {
    if (pinId === "headers") return z.object({}).passthrough();
    return null;
  }
  if (sourceNode.type === "serveStatic") {
    if (pinId === "filePath" || pinId === "contentType") return z.string();
    if (pinId === "found") return z.boolean();
    return null;
  }
  if (sourceNode.type === "httpListen") {
    if (pinId === "method" || pinId === "path" || pinId === "query") return z.string();
    if (pinId === "headers") return z.object({}).passthrough();
    return null;
  }

  if (sourceNode.type === "onEvent") {
    // Look up the payload field on the matching Emit Event(s) and return
    // its declared type as a Zod primitive.
    const name = (sourceNode.data as { name?: string } | undefined)?.name;
    if (!name) return null;
    for (const n of allNodes) {
      if (n.type !== "emitEvent") continue;
      const ed = (n.data ?? {}) as {
        name?: string;
        payload?: Array<{ key: string; type: string }>;
      };
      if (ed.name !== name) continue;
      const field = (ed.payload ?? []).find((p) => p.key === pinId);
      if (field) return payloadTypeToZod(field.type);
    }
    return null;
  }

  return null;
}

function payloadTypeToZod(type: string): ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "object":
      return z.object({});
    case "array":
      return z.array(z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Cheap variant — returns just the DataType label of a source pin without
 * keeping the full Zod schema around. Used by UI components that only need
 * to color a pin or filter a dropdown.
 *
 * Returns "unknown" if the source isn't connected or the schema can't be
 * resolved at design time.
 */
export function getSourcePinType(
  sourceNode: Node,
  pinId: string,
  allNodes: Node[],
  allEdges: Edge[],
): DataType {
  // Fast path for primitive sources where we don't need to evaluate Zod
  if (
    (sourceNode.type === "forEachSequential" || sourceNode.type === "forEachParallel") &&
    pinId === "index"
  ) {
    return "number";
  }

  if (sourceNode.type === "envVar") return "string";

  if (sourceNode.type === "convert") {
    const target = (sourceNode.data as { targetType?: string } | undefined)?.targetType;
    return convertTargetToDataType(target);
  }

  if (sourceNode.type === "tap") {
    // Transparent — defer to upstream
    const inEdge = allEdges.find(
      (e) => e.target === sourceNode.id && e.targetHandle === "in:value",
    );
    if (!inEdge) return "unknown";
    const upstream = allNodes.find((n) => n.id === inEdge.source);
    if (!upstream) return "unknown";
    return getSourcePinType(
      upstream,
      (inEdge.sourceHandle ?? "").replace(/^out:/, ""),
      allNodes,
      allEdges,
    );
  }

  if (sourceNode.type === "makeObject") return "object";

  // HTTP Server node fast paths
  if (sourceNode.type === "route") {
    if (pinId === "params" || pinId === "query") return "object";
    return "unknown";
  }
  if (sourceNode.type === "parseBody") {
    if (pinId === "contentType") return "string";
    return "unknown";
  }
  if (sourceNode.type === "cors") return "object";
  if (sourceNode.type === "verifyAuth") {
    if (pinId === "claims") return "object";
    if (pinId === "token" || pinId === "error") return "string";
    return "unknown";
  }
  if (sourceNode.type === "rateLimit") {
    if (pinId === "remaining") return "number";
    if (pinId === "rateLimitHeaders") return "object";
    return "unknown";
  }
  if (sourceNode.type === "cookie") return "object";
  if (sourceNode.type === "setHeaders") return "object";
  if (sourceNode.type === "serveStatic") {
    if (pinId === "filePath" || pinId === "contentType") return "string";
    if (pinId === "found") return "boolean";
    return "unknown";
  }
  if (sourceNode.type === "httpListen") {
    if (pinId === "method" || pinId === "path" || pinId === "query") return "string";
    if (pinId === "headers") return "object";
    return "unknown";
  }

  if (sourceNode.type === "function") {
    // Look up the declared output type for this pin
    const outputs =
      ((sourceNode.data as { outputs?: Array<{ key: string; type: DataType }> } | undefined)
        ?.outputs) ?? [];
    const field = outputs.find((o) => o.key === pinId);
    return field?.type ?? "unknown";
  }

  if (sourceNode.type === "onEvent") {
    // Find the matching emitter, look up the payload field type
    const name = (sourceNode.data as { name?: string } | undefined)?.name;
    if (!name) return "unknown";
    for (const n of allNodes) {
      if (n.type !== "emitEvent") continue;
      const ed = (n.data ?? {}) as {
        name?: string;
        payload?: Array<{ key: string; type: DataType }>;
      };
      if (ed.name !== name) continue;
      const field = (ed.payload ?? []).find((p) => p.key === pinId);
      if (field) return field.type;
    }
    return "unknown";
  }

  // Everything else: resolve the schema and classify it
  const schema = resolveSourcePinSchema(sourceNode, pinId, allNodes, allEdges);
  if (!schema) return "unknown";
  return schemaToDataType(schema);
}

/**
 * Convenience for the most common case: given a node id and an input pin,
 * find the edge feeding it and return the source pin's type.
 */
export function getInputPinSourceType(
  nodeId: string,
  inputPinId: string,
  allNodes: Node[],
  allEdges: Edge[],
): DataType {
  const inEdge = allEdges.find(
    (e) => e.target === nodeId && e.targetHandle === inputPinId,
  );
  if (!inEdge) return "unknown";
  const sourceNode = allNodes.find((n) => n.id === inEdge.source);
  if (!sourceNode) return "unknown";
  const sourcePin = (inEdge.sourceHandle ?? "").replace(/^out:/, "");
  return getSourcePinType(sourceNode, sourcePin, allNodes, allEdges);
}

// ─── Internal helpers ──────────────────────────────────────────

function extractField(schema: ZodTypeAny, fieldName: string): ZodTypeAny | null {
  const def = schema._def;
  if (def?.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    return (shape[fieldName] as ZodTypeAny | undefined) ?? null;
  }
  if (fieldName === "value") return schema;
  return null;
}

function unwrapOptional(schema: ZodTypeAny): ZodTypeAny {
  let cur: ZodTypeAny = schema;
  while (
    cur._def?.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
    cur._def?.typeName === z.ZodFirstPartyTypeKind.ZodNullable ||
    cur._def?.typeName === z.ZodFirstPartyTypeKind.ZodDefault
  ) {
    cur = (cur._def as { innerType?: ZodTypeAny }).innerType ?? cur;
  }
  return cur;
}

function schemaToDataType(schema: ZodTypeAny): DataType {
  const def = unwrapOptional(schema)._def;
  switch (def?.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return "string";
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return "number";
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return "boolean";
    case z.ZodFirstPartyTypeKind.ZodNull:
      return "null";
    case z.ZodFirstPartyTypeKind.ZodObject:
      return "object";
    case z.ZodFirstPartyTypeKind.ZodArray:
      return "array";
    default:
      return "unknown";
  }
}

function convertTargetToZod(target: string | undefined): ZodTypeAny {
  switch (target) {
    case "string":
    case "json":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    default:
      return z.string();
  }
}

function convertTargetToDataType(target: string | undefined): DataType {
  switch (target) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
    case "json":
    default:
      return "string";
  }
}
