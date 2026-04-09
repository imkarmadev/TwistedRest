import { z } from "zod";

/**
 * A Project is the top-level container.
 *
 * It owns global request defaults (base URL, default headers), a set of
 * named environments (dev/staging/prod...), and any number of flows.
 *
 * All persisted records carry UUIDs + updated_at + soft-delete columns
 * so the SQLite store can be synced to a remote service later without
 * a schema migration.
 */
export const HeaderEntry = z.object({
  key: z.string(),
  /** Template string — supports `#{name}` tokens. */
  value: z.string(),
  enabled: z.boolean().default(true),
});
export type HeaderEntry = z.infer<typeof HeaderEntry>;

export const Project = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  baseUrl: z.string().default(""),
  defaultHeaders: z.array(HeaderEntry).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().default(null),
});
export type Project = z.infer<typeof Project>;

export const ProjectSummary = Project.pick({
  id: true,
  name: true,
  updatedAt: true,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;
