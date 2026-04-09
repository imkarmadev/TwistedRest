import { describe, test, expect, mock } from "bun:test";
import {
  runFlow,
  type ExecNode,
  type ExecEdge,
  type ExecutorOptions,
  type StatusEvent,
  type ExecHttpResponse,
} from "./executor";

// ─── Test helpers ──────────────────────────────────────────────

function mockFetch(
  responses: Record<string, ExecHttpResponse>,
): ExecutorOptions["fetch"] {
  return async (req) => {
    const key = `${req.method} ${req.url}`;
    return (
      responses[key] ?? {
        status: 200,
        headers: [],
        body: JSON.stringify({ ok: true }),
      }
    );
  };
}

function noopEvalSchema(): null {
  return null;
}

function statusTracker() {
  const statuses: Array<{ id: string; event: StatusEvent }> = [];
  return {
    statuses,
    onStatus: (id: string, event: StatusEvent) => {
      statuses.push({ id, event });
    },
    lastStatus(id: string) {
      for (let i = statuses.length - 1; i >= 0; i--) {
        if (statuses[i]!.id === id) return statuses[i]!.event;
      }
      return undefined;
    },
  };
}

function makeNode(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): ExecNode {
  return { id, type, data };
}

function makeEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  kind: "exec" | "data" = "exec",
): ExecEdge {
  return {
    source,
    sourceHandle,
    target,
    targetHandle,
    data: { kind },
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe("executor — basic chain", () => {
  test("Start → HTTP → ok", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/users",
      headers: [],
      body: "",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const tracker = statusTracker();
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: mockFetch({
        "GET https://api.test/users": {
          status: 200,
          headers: [],
          body: JSON.stringify({ id: 1, name: "Alice" }),
        },
      }),
      evalSchema: noopEvalSchema,
      onStatus: tracker.onStatus,
    });

    expect(tracker.lastStatus("s")?.status).toBe("ok");
    expect(tracker.lastStatus("h")?.status).toBe("ok");
    expect(tracker.lastStatus("h")?.output?.id).toBe(1);
    expect(tracker.lastStatus("h")?.output?.name).toBe("Alice");
    // _request metadata is also included in output
    expect(tracker.lastStatus("h")?.output?._request).toBeTruthy();
  });

  test("HTTP 5xx does NOT halt chain — continues with status pin", async () => {
    const start = makeNode("s", "start");
    const http1 = makeNode("h1", "httpRequest", {
      method: "GET",
      url: "https://api.test/fail",
      responseSchema: "",
    });
    const http2 = makeNode("h2", "httpRequest", {
      method: "GET",
      url: "https://api.test/ok",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h1", "exec-in"),
      makeEdge("h1", "exec-out", "h2", "exec-in"),
    ];

    const tracker = statusTracker();
    await runFlow({
      nodes: [start, http1, http2],
      edges,
      fetch: mockFetch({
        "GET https://api.test/fail": {
          status: 500,
          headers: [],
          body: "Internal Server Error",
        },
      }),
      evalSchema: noopEvalSchema,
      onStatus: tracker.onStatus,
    });

    // h1 completes with status 500 — chain continues
    expect(tracker.lastStatus("h1")?.status).toBe("ok");
    expect(tracker.lastStatus("h1")?.output?.status).toBe(500);
    // h2 runs because the chain wasn't halted
    expect(tracker.lastStatus("h2")?.status).toBe("ok");
  });

  test("no Start node throws", async () => {
    const http = makeNode("h", "httpRequest", { url: "x" });

    await expect(
      runFlow({
        nodes: [http],
        edges: [],
        fetch: mockFetch({}),
        evalSchema: noopEvalSchema,
        onStatus: () => {},
      }),
    ).rejects.toThrow("no Start node");
  });
});

describe("executor — template substitution", () => {
  test("#{token} resolved from upstream data edge", async () => {
    const start = makeNode("s", "start");
    const http1 = makeNode("h1", "httpRequest", {
      method: "GET",
      url: "https://api.test/users/1",
      responseSchema: "",
    });
    const http2 = makeNode("h2", "httpRequest", {
      method: "GET",
      url: "https://api.test/posts/#{userId}",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h1", "exec-in"),
      makeEdge("h1", "exec-out", "h2", "exec-in"),
      makeEdge("h1", "out:id", "h2", "in:userId", "data"),
    ];

    const fetched: string[] = [];
    const tracker = statusTracker();
    await runFlow({
      nodes: [start, http1, http2],
      edges,
      fetch: async (req) => {
        fetched.push(req.url);
        if (req.url.includes("/users/1")) {
          return {
            status: 200,
            headers: [],
            body: JSON.stringify({ id: 42, name: "Bob" }),
          };
        }
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: tracker.onStatus,
    });

    expect(fetched).toContain("https://api.test/posts/42");
  });
});

describe("executor — EnvVar node", () => {
  test("EnvVar resolves from context envVars", async () => {
    const start = makeNode("s", "start");
    const envNode = makeNode("e", "envVar", { varKey: "API_KEY" });
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/data",
      headers: [{ key: "Authorization", value: "Bearer #{token}", enabled: true }],
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h", "exec-in"),
      makeEdge("e", "out:value", "h", "in:token", "data"),
    ];

    const sentHeaders: Array<[string, string]>[] = [];
    await runFlow({
      nodes: [start, envNode, http],
      edges,
      fetch: async (req) => {
        sentHeaders.push(req.headers);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: { envVars: { API_KEY: "sk-test-123" } },
    });

    expect(sentHeaders[0]).toContainEqual([
      "Authorization",
      "Bearer sk-test-123",
    ]);
  });
});

describe("executor — Convert node", () => {
  test("number → string conversion", async () => {
    const start = makeNode("s", "start");
    const http1 = makeNode("h1", "httpRequest", {
      method: "GET",
      url: "https://api.test/user",
      responseSchema: "",
    });
    const convert = makeNode("c", "convert", { targetType: "string" });
    const http2 = makeNode("h2", "httpRequest", {
      method: "GET",
      url: "https://api.test/posts/#{userId}",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h1", "exec-in"),
      makeEdge("h1", "exec-out", "h2", "exec-in"),
      makeEdge("h1", "out:id", "c", "in:value", "data"),
      makeEdge("c", "out:value", "h2", "in:userId", "data"),
    ];

    const urls: string[] = [];
    await runFlow({
      nodes: [start, http1, convert, http2],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        if (req.url.includes("/user")) {
          return {
            status: 200,
            headers: [],
            body: JSON.stringify({ id: 7 }),
          };
        }
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
    });

    // id=7 (number) should become "7" (string) in the URL
    expect(urls).toContain("https://api.test/posts/7");
  });
});

describe("executor — ForEach Sequential", () => {
  test("iterates array, runs body per item", async () => {
    const start = makeNode("s", "start");
    const http1 = makeNode("h1", "httpRequest", {
      method: "GET",
      url: "https://api.test/users",
      responseSchema: "",
    });
    const forEach = makeNode("fe", "forEachSequential");
    const http2 = makeNode("h2", "httpRequest", {
      method: "GET",
      url: "https://api.test/item",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h1", "exec-in"),
      makeEdge("h1", "exec-out", "fe", "exec-in"),
      makeEdge("h1", "out:value", "fe", "in:array", "data"),
      makeEdge("fe", "exec-body", "h2", "exec-in"),
    ];

    let bodyCallCount = 0;
    await runFlow({
      nodes: [start, http1, forEach, http2],
      edges,
      fetch: async (req) => {
        if (req.url.includes("/users")) {
          return {
            status: 200,
            headers: [],
            body: JSON.stringify([1, 2, 3]),
          };
        }
        bodyCallCount++;
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
    });

    expect(bodyCallCount).toBe(3);
  });
});

describe("executor — ForEach Parallel", () => {
  test("all items fire concurrently", async () => {
    const start = makeNode("s", "start");
    const http1 = makeNode("h1", "httpRequest", {
      method: "GET",
      url: "https://api.test/items",
      responseSchema: "",
    });
    const forEach = makeNode("fe", "forEachParallel");
    const http2 = makeNode("h2", "httpRequest", {
      method: "GET",
      url: "https://api.test/process",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h1", "exec-in"),
      makeEdge("h1", "exec-out", "fe", "exec-in"),
      makeEdge("h1", "out:value", "fe", "in:array", "data"),
      makeEdge("fe", "exec-body", "h2", "exec-in"),
    ];

    let maxConcurrent = 0;
    let current = 0;

    await runFlow({
      nodes: [start, http1, forEach, http2],
      edges,
      fetch: async (req) => {
        if (req.url.includes("/items")) {
          return {
            status: 200,
            headers: [],
            body: JSON.stringify([1, 2, 3, 4, 5]),
          };
        }
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 10));
        current--;
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
    });

    // All 5 should have been in-flight at the same time
    expect(maxConcurrent).toBe(5);
  });
});

describe("executor — Emit/On Event", () => {
  test("emitter fans out to listeners", async () => {
    const start = makeNode("s", "start");
    const emitter = makeNode("em", "emitEvent", {
      name: "test",
      payload: [{ key: "val", type: "number" }],
    });
    const listener = makeNode("on", "onEvent", { name: "test" });
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/listen",
      responseSchema: "",
    });

    // EnvVar to feed the emitter's payload input
    const envNode = makeNode("e", "envVar", { varKey: "myVal" });

    const edges = [
      makeEdge("s", "exec-out", "em", "exec-in"),
      makeEdge("e", "out:value", "em", "in:val", "data"),
      makeEdge("on", "exec-out", "h", "exec-in"),
    ];

    const tracker = statusTracker();
    await runFlow({
      nodes: [start, emitter, listener, http, envNode],
      edges,
      fetch: async () => ({ status: 200, headers: [], body: "{}" }),
      evalSchema: noopEvalSchema,
      onStatus: tracker.onStatus,
      context: { envVars: { myVal: 42 } },
    });

    expect(tracker.lastStatus("em")?.status).toBe("ok");
    expect(tracker.lastStatus("on")?.status).toBe("ok");
    expect(tracker.lastStatus("on")?.output?.val).toBe(42);
    expect(tracker.lastStatus("h")?.status).toBe("ok");
  });
});

describe("executor — Log node", () => {
  test("calls onLog with label and value", async () => {
    const start = makeNode("s", "start");
    const envNode = makeNode("e", "envVar", { varKey: "msg" });
    const logNode = makeNode("l", "log", { label: "TestLog" });
    const edges = [
      makeEdge("s", "exec-out", "l", "exec-in"),
      makeEdge("e", "out:value", "l", "in:value", "data"),
    ];

    const logged: Array<{ label: string; value: unknown }> = [];
    await runFlow({
      nodes: [start, envNode, logNode],
      edges,
      fetch: async () => ({ status: 200, headers: [], body: "{}" }),
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      onLog: (entry) => logged.push(entry),
      context: { envVars: { msg: "hello world" } },
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]!.label).toBe("TestLog");
    expect(logged[0]!.value).toBe("hello world");
  });
});

describe("executor — Function node", () => {
  test("executes user code and returns output", async () => {
    const start = makeNode("s", "start");
    const envNode = makeNode("e", "envVar", { varKey: "name" });
    const fnNode = makeNode("f", "function", {
      inputs: [{ key: "name", type: "string" }],
      outputs: [{ key: "greeting", type: "string" }],
      code: 'return { greeting: `Hello ${inputs.name}!` }',
    });
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/#{msg}",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h", "exec-in"),
      makeEdge("e", "out:value", "f", "in:name", "data"),
      makeEdge("f", "out:greeting", "h", "in:msg", "data"),
    ];

    const urls: string[] = [];
    await runFlow({
      nodes: [start, envNode, fnNode, http],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: { envVars: { name: "World" } },
    });

    expect(urls[0]).toBe("https://api.test/Hello World!");
  });

  test("function error surfaces as node status error", async () => {
    const start = makeNode("s", "start");
    const fnNode = makeNode("f", "function", {
      inputs: [],
      outputs: [{ key: "x", type: "string" }],
      code: "throw new Error('boom')",
    });
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/#{val}",
      responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "h", "exec-in"),
      makeEdge("f", "out:x", "h", "in:val", "data"),
    ];

    const tracker = statusTracker();
    await runFlow({
      nodes: [start, fnNode, http],
      edges,
      fetch: async () => ({ status: 200, headers: [], body: "{}" }),
      evalSchema: noopEvalSchema,
      onStatus: tracker.onStatus,
    });

    expect(tracker.lastStatus("f")?.status).toBe("error");
    expect(tracker.lastStatus("f")?.error).toContain("boom");
  });
});

describe("executor — Match node", () => {
  test("routes to matching case", async () => {
    const start = makeNode("s", "start");
    const envNode = makeNode("e", "envVar", { varKey: "role" });
    const match = makeNode("m", "match", {
      cases: [
        { value: "admin" },
        { value: "user" },
      ],
    });
    const httpAdmin = makeNode("ha", "httpRequest", {
      method: "GET", url: "https://api.test/admin", responseSchema: "",
    });
    const httpUser = makeNode("hu", "httpRequest", {
      method: "GET", url: "https://api.test/user", responseSchema: "",
    });
    const httpDefault = makeNode("hd", "httpRequest", {
      method: "GET", url: "https://api.test/default", responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "m", "exec-in"),
      makeEdge("e", "out:value", "m", "in:value", "data"),
      makeEdge("m", "exec-case:0", "ha", "exec-in"),
      makeEdge("m", "exec-case:1", "hu", "exec-in"),
      makeEdge("m", "exec-default", "hd", "exec-in"),
    ];

    const urls: string[] = [];
    const tracker = statusTracker();
    await runFlow({
      nodes: [start, envNode, match, httpAdmin, httpUser, httpDefault],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: tracker.onStatus,
      context: { envVars: { role: "user" } },
    });

    // Only the "user" branch should have fired
    expect(urls).toEqual(["https://api.test/user"]);
    expect(tracker.lastStatus("hu")?.status).toBe("ok");
    expect(tracker.lastStatus("ha")?.status).toBe("pending");
    expect(tracker.lastStatus("hd")?.status).toBe("pending");
  });

  test("routes to default when no case matches", async () => {
    const start = makeNode("s", "start");
    const envNode = makeNode("e", "envVar", { varKey: "role" });
    const match = makeNode("m", "match", {
      cases: [{ value: "admin" }],
    });
    const httpAdmin = makeNode("ha", "httpRequest", {
      method: "GET", url: "https://api.test/admin", responseSchema: "",
    });
    const httpDefault = makeNode("hd", "httpRequest", {
      method: "GET", url: "https://api.test/default", responseSchema: "",
    });
    const edges = [
      makeEdge("s", "exec-out", "m", "exec-in"),
      makeEdge("e", "out:value", "m", "in:value", "data"),
      makeEdge("m", "exec-case:0", "ha", "exec-in"),
      makeEdge("m", "exec-default", "hd", "exec-in"),
    ];

    const urls: string[] = [];
    await runFlow({
      nodes: [start, envNode, match, httpAdmin, httpDefault],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: { envVars: { role: "guest" } },
    });

    expect(urls).toEqual(["https://api.test/default"]);
  });
});

describe("executor — auth", () => {
  test("bearer token injected", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/me",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const sentHeaders: Array<[string, string]>[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        sentHeaders.push(req.headers);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        auth: { authType: "bearer", bearerToken: "sk-test-xxx" },
      },
    });

    expect(sentHeaders[0]).toContainEqual([
      "Authorization",
      "Bearer sk-test-xxx",
    ]);
  });

  test("basic auth header", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/me",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const sentHeaders: Array<[string, string]>[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        sentHeaders.push(req.headers);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        auth: {
          authType: "basic",
          basicUsername: "user",
          basicPassword: "pass",
        },
      },
    });

    expect(sentHeaders[0]).toContainEqual([
      "Authorization",
      `Basic ${btoa("user:pass")}`,
    ]);
  });

  test("API key in header", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/data",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const sentHeaders: Array<[string, string]>[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        sentHeaders.push(req.headers);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        auth: {
          authType: "apiKey",
          apiKeyName: "X-API-Key",
          apiKeyValue: "abc123",
          apiKeyLocation: "header",
        },
      },
    });

    expect(sentHeaders[0]).toContainEqual(["X-API-Key", "abc123"]);
  });

  test("API key in query param", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/data",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const urls: string[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        auth: {
          authType: "apiKey",
          apiKeyName: "key",
          apiKeyValue: "secret",
          apiKeyLocation: "query",
        },
      },
    });

    expect(urls[0]).toBe("https://api.test/data?key=secret");
  });

  test("oauth2 access token injected as bearer", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test/resource",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const sentHeaders: Array<[string, string]>[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        sentHeaders.push(req.headers);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        auth: {
          authType: "oauth2_client_credentials",
          oauth2AccessToken: "eyJhbGciOi...",
        },
      },
    });

    expect(sentHeaders[0]).toContainEqual([
      "Authorization",
      "Bearer eyJhbGciOi...",
    ]);
  });
});

describe("executor — context", () => {
  test("baseUrl prepended to relative URLs", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "/users",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const urls: string[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: { envBaseUrl: "https://api.dev.test" },
    });

    expect(urls[0]).toBe("https://api.dev.test/users");
  });

  test("env baseUrl wins over project baseUrl", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "/data",
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const urls: string[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        urls.push(req.url);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        projectBaseUrl: "https://project.test",
        envBaseUrl: "https://env.test",
      },
    });

    expect(urls[0]).toBe("https://env.test/data");
  });

  test("three-layer header merge", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test",
      headers: [{ key: "X-Node", value: "node-val", enabled: true }],
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    const sentHeaders: Array<[string, string]>[] = [];
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        sentHeaders.push(req.headers);
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
      context: {
        projectHeaders: [
          { key: "X-Project", value: "proj", enabled: true },
          { key: "X-Shared", value: "from-project", enabled: true },
        ],
        envHeaders: [
          { key: "X-Env", value: "env", enabled: true },
          { key: "X-Shared", value: "from-env", enabled: true },
        ],
      },
    });

    const headers = sentHeaders[0]!;
    expect(headers).toContainEqual(["X-Project", "proj"]);
    expect(headers).toContainEqual(["X-Env", "env"]);
    expect(headers).toContainEqual(["X-Node", "node-val"]);
    // env should override project for the shared key
    expect(headers).toContainEqual(["X-Shared", "from-env"]);
    expect(headers).not.toContainEqual(["X-Shared", "from-project"]);
  });

  test("GET requests don't send body", async () => {
    const start = makeNode("s", "start");
    const http = makeNode("h", "httpRequest", {
      method: "GET",
      url: "https://api.test",
      body: '{"shouldnt": "send"}',
      responseSchema: "",
    });
    const edges = [makeEdge("s", "exec-out", "h", "exec-in")];

    let sentBody: string | null = null;
    await runFlow({
      nodes: [start, http],
      edges,
      fetch: async (req) => {
        sentBody = req.body;
        return { status: 200, headers: [], body: "{}" };
      },
      evalSchema: noopEvalSchema,
      onStatus: () => {},
    });

    expect(sentBody).toBeNull();
  });
});
