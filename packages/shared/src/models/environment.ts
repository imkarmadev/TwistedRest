import { z } from "zod";

/**
 * Environments hold per-project key/value bags. Selected at the Start node.
 * Values are templatable but typically literal.
 */
export const EnvironmentVar = z.object({
  key: z.string(),
  value: z.string(),
  secret: z.boolean().default(false),
});
export type EnvironmentVar = z.infer<typeof EnvironmentVar>;

export const Environment = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  vars: z.array(EnvironmentVar).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().default(null),
});
export type Environment = z.infer<typeof Environment>;
