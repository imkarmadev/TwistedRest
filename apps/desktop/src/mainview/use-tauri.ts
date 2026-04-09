/**
 * Tauri command bridge for the React app.
 *
 * Replaces the old Electrobun RPC layer. Each method maps to a
 * `#[tauri::command]` in src-tauri/src/commands.rs and is called via
 * `invoke()` from `@tauri-apps/api/core`.
 *
 * Window controls go through `getCurrentWindow()` from
 * `@tauri-apps/api/window`. Native traffic lights are handled by macOS
 * directly (we set `decorations: true` + `titleBarStyle: Overlay` in
 * tauri.conf.json), so this hook only exposes minimize/maximize/close
 * for parity with the old API in case we need them later.
 */

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface HeaderEntry {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ProjectDetail {
  id: string;
  name: string;
  baseUrl: string;
  headers: HeaderEntry[];
  updatedAt: string;
}

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export type AuthType =
  | "none"
  | "bearer"
  | "basic"
  | "apiKey"
  | "oauth2_client_credentials";

export interface AuthConfig {
  authType: AuthType;
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyLocation: "header" | "query";
  oauth2TokenUrl: string;
  oauth2ClientId: string;
  oauth2ClientSecret: string;
  oauth2Scopes: string;
  oauth2AccessToken: string;
  oauth2ExpiresAt: number;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  vars: EnvVar[];
  baseUrl: string;
  headers: HeaderEntry[];
  auth: AuthConfig;
  updatedAt: string;
}

export interface FlowSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface FlowDetail {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
}

export interface RPC {
  request: {
    // Projects
    listProjects: (params: {}) => Promise<ProjectSummary[]>;
    getProject: (params: { id: string }) => Promise<ProjectDetail | null>;
    createProject: (params: { name: string }) => Promise<{ id: string; name: string }>;
    updateProject: (params: {
      id: string;
      name: string;
      baseUrl: string;
      headers: HeaderEntry[];
    }) => Promise<{ success: boolean }>;
    deleteProject: (params: { id: string }) => Promise<{ success: boolean }>;

    // Environments
    listEnvironments: (params: { projectId: string }) => Promise<Environment[]>;
    createEnvironment: (params: { projectId: string; name: string }) => Promise<Environment>;
    updateEnvironment: (params: {
      id: string;
      name: string;
      vars: EnvVar[];
      baseUrl: string;
      headers: HeaderEntry[];
      auth: AuthConfig;
    }) => Promise<{ success: boolean }>;

    /** OAuth2 Client Credentials token exchange via Rust. */
    oauth2FetchToken: (params: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scopes: string;
    }) => Promise<{ accessToken: string; expiresAt: number } | null>;
    deleteEnvironment: (params: { id: string }) => Promise<{ success: boolean }>;

    // Flows
    listFlows: (params: { projectId: string }) => Promise<FlowSummary[]>;
    getFlow: (params: { id: string }) => Promise<FlowDetail | null>;
    createFlow: (params: { projectId: string; name: string }) => Promise<{ id: string; name: string }>;
    saveFlow: (params: { id: string; nodes: unknown[]; edges: unknown[]; viewport?: { x: number; y: number; zoom: number } }) => Promise<{ success: boolean }>;
    renameFlow: (params: { id: string; name: string }) => Promise<{ success: boolean }>;
    deleteFlow: (params: { id: string }) => Promise<{ success: boolean }>;
  };
  send: {
    closeWindow: (params: {}) => void;
    minimizeWindow: (params: {}) => void;
    maximizeWindow: (params: {}) => void;
  };
}

/**
 * Wraps Tauri's invoke + window APIs in the same shape the components
 * already use, so the migration from Electrobun is purely a hook swap.
 *
 * Errors from invoke are surfaced via console.error and the failing call
 * resolves to a sensible empty value, matching the old Electrobun handlers
 * which also returned `[]` / `{ success: false }` on failure.
 */
function makeRpc(): RPC {
  const win = getCurrentWindow();

  const safe = async <T,>(cmd: string, args: InvokeArgs, fallback: T): Promise<T> => {
    try {
      return (await invoke<T>(cmd, args)) ?? fallback;
    } catch (err) {
      console.error(`[invoke ${cmd}]`, err);
      return fallback;
    }
  };

  return {
    request: {
      listProjects: () => safe<ProjectSummary[]>("list_projects", {}, []),

      createProject: ({ name }) =>
        safe<{ id: string; name: string }>("create_project", { name }, { id: "", name: "" }),

      getProject: ({ id }) => safe<ProjectDetail | null>("get_project", { id }, null),

      updateProject: async ({ id, name, baseUrl, headers }) => {
        try {
          await invoke("update_project", { id, name, baseUrl, headers });
          return { success: true };
        } catch (err) {
          console.error("[invoke update_project]", err);
          return { success: false };
        }
      },

      deleteProject: async ({ id }) => {
        try {
          await invoke("delete_project", { id });
          return { success: true };
        } catch (err) {
          console.error("[invoke delete_project]", err);
          return { success: false };
        }
      },

      // ── Environments ──────────────────────────────────────

      listEnvironments: ({ projectId }) =>
        safe<Environment[]>("list_environments", { projectId }, []),

      createEnvironment: ({ projectId, name }) =>
        safe<Environment>(
          "create_environment",
          { projectId, name },
          {
            id: "", projectId, name, vars: [], baseUrl: "", headers: [],
            auth: {
              authType: "none", bearerToken: "", basicUsername: "", basicPassword: "",
              apiKeyName: "", apiKeyValue: "", apiKeyLocation: "header",
              oauth2TokenUrl: "", oauth2ClientId: "", oauth2ClientSecret: "",
              oauth2Scopes: "", oauth2AccessToken: "", oauth2ExpiresAt: 0,
            },
            updatedAt: "",
          },
        ),

      updateEnvironment: async ({ id, name, vars, baseUrl, headers, auth }) => {
        try {
          await invoke("update_environment", { id, name, vars, baseUrl, headers, auth });
          return { success: true };
        } catch (err) {
          console.error("[invoke update_environment]", err);
          return { success: false };
        }
      },

      oauth2FetchToken: async ({ tokenUrl, clientId, clientSecret, scopes }) => {
        try {
          return await invoke<{ accessToken: string; expiresAt: number }>(
            "oauth2_client_credentials",
            { tokenUrl, clientId, clientSecret, scopes },
          );
        } catch (err) {
          console.error("[invoke oauth2_client_credentials]", err);
          return null;
        }
      },

      deleteEnvironment: async ({ id }) => {
        try {
          await invoke("delete_environment", { id });
          return { success: true };
        } catch (err) {
          console.error("[invoke delete_environment]", err);
          return { success: false };
        }
      },

      listFlows: ({ projectId }) =>
        safe<FlowSummary[]>("list_flows", { projectId }, []),

      getFlow: ({ id }) => safe<FlowDetail | null>("get_flow", { id }, null),

      createFlow: ({ projectId, name }) =>
        safe<{ id: string; name: string }>(
          "create_flow",
          { projectId, name },
          { id: "", name: "" },
        ),

      saveFlow: async ({ id, nodes, edges, viewport }) => {
        try {
          await invoke("save_flow", { id, nodes, edges, viewport });
          return { success: true };
        } catch (err) {
          console.error("[invoke save_flow]", err);
          return { success: false };
        }
      },

      renameFlow: async ({ id, name }) => {
        try {
          await invoke("rename_flow", { id, name });
          return { success: true };
        } catch (err) {
          console.error("[invoke rename_flow]", err);
          return { success: false };
        }
      },

      deleteFlow: async ({ id }) => {
        try {
          await invoke("delete_flow", { id });
          return { success: true };
        } catch (err) {
          console.error("[invoke delete_flow]", err);
          return { success: false };
        }
      },
    },
    send: {
      closeWindow: () => {
        void win.close();
      },
      minimizeWindow: () => {
        void win.minimize();
      },
      maximizeWindow: () => {
        void win.toggleMaximize();
      },
    },
  };
}

/**
 * Returns a stable RPC instance. Tauri's invoke is always available
 * (no async init like Electrobun's webview bridge), so we don't need
 * the `ready` flag the old hook returned.
 */
let cachedRpc: RPC | null = null;
export function useTauri() {
  if (!cachedRpc) cachedRpc = makeRpc();
  return { ready: true, rpc: cachedRpc };
}
