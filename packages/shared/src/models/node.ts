import { z } from "zod";

/**
 * Built-in node kinds. The pin layout for each kind is computed at runtime
 * by packages/core (it walks the response schema for output pins and parses
 * `#{name}` templates in editable fields for input pins).
 */
export const NodeKind = z.enum([
  "start",
  "httpRequest",
  "breakObject",
  "forEachSequential",
  "forEachParallel",
  "log",
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const NodePosition = z.object({
  x: z.number(),
  y: z.number(),
});
export type NodePosition = z.infer<typeof NodePosition>;

/** Configuration for an HttpRequest node. All string fields support `#{name}` tokens. */
export const HttpRequestConfig = z.object({
  method: HttpMethod.default("GET"),
  url: z.string().default(""),
  headers: z
    .array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean().default(true) }))
    .default([]),
  body: z.string().default(""),
  /**
   * Source code of the response Zod schema. Stored as text so users can
   * hand-edit it; the executor evaluates it at run time.
   *
   * Example: `z.object({ id: z.string(), name: z.string() })`
   */
  responseSchema: z.string().default("z.unknown()"),
});
export type HttpRequestConfig = z.infer<typeof HttpRequestConfig>;

/** Start-node config: which environment to inject. */
export const StartConfig = z.object({
  environmentId: z.string().uuid().nullable().default(null),
});
export type StartConfig = z.infer<typeof StartConfig>;

export const FlowNode = z.object({
  id: z.string().uuid(),
  kind: NodeKind,
  position: NodePosition,
  /** Free-form per-kind config; validated by the executor against the kind. */
  config: z.record(z.unknown()).default({}),
});
export type FlowNode = z.infer<typeof FlowNode>;
