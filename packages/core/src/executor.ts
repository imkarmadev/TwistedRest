/**
 * Flow executor.
 *
 * Walks the exec-edge DAG starting from the Start node, runs each
 * HttpRequest node, resolves input pin values from upstream outputs,
 * fires HTTP via an injected fetch transport, validates the response
 * against the node's Zod schema, and emits per-node status.
 *
 * The executor is pure logic — it knows nothing about React Flow or
 * Tauri. The frontend wraps it (see apps/desktop/src/mainview/components/
 * canvas/flow-canvas.tsx) to inject the actual fetch (Tauri invoke),
 * schema evaluator (eval Zod source), and status callbacks.
 *
 * As of Phase 7 the executor uses a recursive chain walker so a sub-chain
 * can be re-entered N times (this is what ForEach iteration needs).
 */

import type { ZodTypeAny } from "zod";
import { renderTemplate } from "./template.js";

export type NodeStatus = "idle" | "pending" | "running" | "ok" | "error";

export interface ExecHttpRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string | null;
}

export interface ExecHttpResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

/** Minimal node shape — matches React Flow's Node<T> in the parts we use. */
export interface ExecNode {
  id: string;
  type?: string;
  data: Record<string, unknown>;
}

/** Minimal edge shape — matches React Flow's Edge in the parts we use. */
export interface ExecEdge {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  data?: { kind?: "exec" | "data" };
}

export interface StatusEvent {
  status: NodeStatus;
  /** On `ok`: the resolved output map keyed by pin id. */
  output?: Record<string, unknown>;
  /** On `error`: human-readable error message. */
  error?: string;
  /**
   * When schema validation fails, the executor stores the raw parsed
   * response body so the inspector can offer a "regenerate schema from
   * this response" action. Undefined for non-validation errors.
   */
  rawResponse?: unknown;
}

/**
 * Per-run execution context — applied to every HTTP node.
 *
 * Layering rules:
 *
 *   baseUrl resolution (first non-empty wins):
 *     1. envBaseUrl       — set on the active environment
 *     2. projectBaseUrl   — set on the project
 *
 *   header merging (order; later overrides earlier on key collision):
 *     1. projectHeaders   — project-level defaults (rare overrides)
 *     2. envHeaders       — environment-specific (e.g. dev vs prod auth)
 *     3. node headers     — per-request from the HTTP node itself
 *
 *   envVars are NOT injected into template resolution. Templates only
 *   resolve from upstream data edges. To use an env value in a request,
 *   drop an EnvVar node and wire its output pin to the input pin.
 */
/** Auth configuration resolved from the active environment. */
export interface ExecAuth {
  authType: string;
  bearerToken?: string;
  basicUsername?: string;
  basicPassword?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyLocation?: string;
  oauth2AccessToken?: string;
}

export interface ExecContext {
  projectBaseUrl?: string;
  envBaseUrl?: string;
  projectHeaders?: Array<{ key: string; value: string; enabled?: boolean }>;
  envHeaders?: Array<{ key: string; value: string; enabled?: boolean }>;
  /** Active environment variables, keyed by name. Used to evaluate EnvVar nodes. */
  envVars?: Record<string, unknown>;
  /** Auth from the active environment. Applied after all header merges. */
  auth?: ExecAuth;
}

export interface ExecutorOptions {
  nodes: ExecNode[];
  edges: ExecEdge[];
  /** Tauri invoke wrapper or any HTTP transport. */
  fetch: (req: ExecHttpRequest) => Promise<ExecHttpResponse>;
  /** Evaluates a Zod schema source string. Return null if the source is invalid. */
  evalSchema: (src: string) => ZodTypeAny | null;
  /** Status callback fired on every state transition for every node. */
  onStatus: (nodeId: string, event: StatusEvent) => void;
  /**
   * Called when a Log node fires. Frontend appends the entry to the
   * console panel state. Optional — leave undefined if there's no
   * console UI to write to.
   */
  onLog?: (entry: { nodeId: string; label: string; value: unknown }) => void;
  /** Optional project-level context. */
  context?: ExecContext;
  /**
   * Abort signal. When signalled, the executor stops at the next node
   * boundary — running HTTP requests are NOT forcibly aborted (the
   * in-flight fetch completes), but no further nodes will execute.
   * The Stop button in the UI signals this.
   */
  signal?: AbortSignal;
}

interface HttpNodeData {
  method?: string;
  url?: string;
  headers?: Array<{ key: string; value: string; enabled?: boolean }>;
  body?: string;
  responseSchema?: string;
}

/** Per-node output cache, mutable. The recursive walker passes it down. */
type Outputs = Record<string, Record<string, unknown>>;

/**
 * Shared per-run log of every value that passed through each Tap node.
 * Lives outside the per-iteration `outputs` cache so parallel ForEach
 * iterations all append into the same array — the user sees the full
 * trace of what flowed through, not just whichever iteration finished
 * last.
 */
type TapLogs = Map<string, unknown[]>;

/**
 * Internal error type that carries the parsed response body alongside
 * the message. Used by the schema validation step so the UI can offer
 * to regenerate the schema from what the API actually returned.
 */
class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: unknown,
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/**
 * Run a flow end-to-end. Resolves when execution completes (successfully
 * or with an error on any node). Errors stop the chain at the failing
 * node and bubble up.
 *
 * Event listeners run on background branches that are fired and forgotten
 * by the emitter — we collect their promises and await them all at the
 * very end so the user's "Run Flow" only becomes idle once everything has
 * finished.
 */
export async function runFlow(opts: ExecutorOptions): Promise<void> {
  const { nodes } = opts;

  const start = nodes.find((n) => n.type === "start");
  if (!start) throw new Error("Flow has no Start node");

  const outputs: Outputs = {};
  const backgroundPromises: Promise<void>[] = [];
  const tapLogs: TapLogs = new Map();

  // Pre-evaluate every EnvVar node — they're pure data, not in any exec
  // chain. The lazy resolver in resolvePinValue can find them, but
  // pre-seeding the cache lets the simple cache lookup hit on the first
  // try without recursion.
  const envVars = opts.context?.envVars ?? {};
  for (const node of nodes) {
    if (node.type !== "envVar") continue;
    const varKey = (node.data as { varKey?: string } | undefined)?.varKey;
    outputs[node.id] = { value: varKey ? envVars[varKey] : undefined };
  }

  // Mark every potentially-exec'd node as pending so the UI shows the
  // queue immediately. We can't statically know which nodes will run
  // (ForEach / event branches), so we mark every non-pure-data node.
  for (const node of nodes) {
    if (node.id === start.id) continue;
    if (
      node.type === "envVar" ||
      node.type === "breakObject" ||
      node.type === "convert" ||
      node.type === "tap"
    )
      continue;
    opts.onStatus(node.id, { status: "pending" });
  }

  opts.onStatus(start.id, { status: "ok" });

  // Walk from the Start node's exec-out
  const startNext = findNextExecNode(start.id, "exec-out", opts.edges);
  if (startNext) {
    await runChain(startNext, opts, outputs, backgroundPromises, tapLogs);
  }

  // Wait for any event-listener branches the main chain spawned
  if (backgroundPromises.length > 0) {
    await Promise.allSettled(backgroundPromises);
  }

  // Eager Tap resolution. Tap is a pure-data node, so it normally only
  // fires when something downstream pulls through it. If a user just
  // wires a Tap onto an HTTP output to observe a value, with nothing
  // beyond it, the lazy model would never resolve it. Walk every Tap
  // that wasn't already resolved during the run and force it now —
  // their upstream is still cached in `outputs`, so the lazy resolver
  // just needs to be poked to write the log entry.
  for (const node of nodes) {
    if (node.type !== "tap") continue;
    if (tapLogs.has(node.id)) continue; // already captured during the chain
    resolvePinValue(node.id, "out:value", opts, outputs, tapLogs);
  }
}

/**
 * Walk a chain of exec-connected nodes starting at `currentId`. Each
 * iteration:
 *   1. Looks up the node by id
 *   2. Dispatches to a per-type handler
 *   3. Follows the node's `exec-out` edge to find the next node
 *
 * ForEach nodes recurse back into runChain for their body sub-chain.
 * Emit Event nodes spawn listener branches into bgPromises so they run
 * concurrently with the main chain. Errors propagate by throwing.
 */
async function runChain(
  startId: string,
  opts: ExecutorOptions,
  outputs: Outputs,
  bgPromises: Promise<void>[],
  tapLogs: TapLogs,
): Promise<void> {
  let currentId: string | null = startId;

  while (currentId) {
    // Check abort signal before each node — this is the "Stop" boundary.
    if (opts.signal?.aborted) return;

    const node = opts.nodes.find((n) => n.id === currentId);
    if (!node) return;

    if (node.type === "httpRequest") {
      opts.onStatus(currentId, { status: "running" });
      try {
        const result = await execHttpNode(node, opts.edges, outputs, opts, tapLogs);
        outputs[currentId] = result;
        opts.onStatus(currentId, { status: "ok", output: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const rawResponse =
          err instanceof SchemaValidationError ? err.rawResponse : undefined;
        opts.onStatus(currentId, { status: "error", error: message, rawResponse });
        return; // halt the whole chain
      }
    } else if (node.type === "forEachSequential") {
      await execForEach(node, opts, outputs, "sequential", bgPromises, tapLogs);
    } else if (node.type === "forEachParallel") {
      await execForEach(node, opts, outputs, "parallel", bgPromises, tapLogs);
    } else if (node.type === "match") {
      // Switch/case routing. Resolve the value input, compare against
      // each configured case (string equality), fire the matching
      // branch. If no match, fire the default branch. After the matched
      // branch completes, the match node is DONE — no exec-out.
      opts.onStatus(currentId, { status: "running" });

      const matchData = node.data as { cases?: Array<{ value: string }> };
      const inEdge = opts.edges.find(
        (e) =>
          e.target === currentId &&
          e.data?.kind === "data" &&
          e.targetHandle === "in:value",
      );
      let matchValue: unknown;
      if (inEdge) {
        matchValue = resolvePinValue(
          inEdge.source,
          inEdge.sourceHandle ?? "",
          opts,
          outputs,
          tapLogs,
        );
      }

      const matchStr = String(matchValue ?? "");
      const cases = matchData.cases ?? [];

      let matchedHandle: string = "exec-default";
      for (let i = 0; i < cases.length; i++) {
        if (matchStr === cases[i]!.value) {
          matchedHandle = `exec-case:${i}`;
          break;
        }
      }

      opts.onStatus(currentId, {
        status: "ok",
        output: { value: matchValue, matched: matchedHandle },
      });

      // Fire the matched branch and return — match terminates the
      // current chain, each case runs its own sub-chain.
      const nextBranch = findNextExecNode(currentId, matchedHandle, opts.edges);
      if (nextBranch) {
        await runChain(nextBranch, opts, outputs, bgPromises, tapLogs);
      }
      return;
    } else if (node.type === "emitEvent") {
      execEmitEvent(node, opts, outputs, bgPromises, tapLogs);
    } else if (node.type === "log") {
      // Resolve the value input, push to the console panel via onLog,
      // emit a status update, then continue to exec-out.
      const inEdge = opts.edges.find(
        (e) =>
          e.target === currentId &&
          e.data?.kind === "data" &&
          e.targetHandle === "in:value",
      );
      let value: unknown = undefined;
      if (inEdge) {
        value = resolvePinValue(
          inEdge.source,
          inEdge.sourceHandle ?? "",
          opts,
          outputs,
          tapLogs,
        );
      }
      const label = ((node.data as { label?: string } | undefined)?.label ?? "Log") || "Log";
      opts.onLog?.({ nodeId: currentId, label, value });
      opts.onStatus(currentId, { status: "ok", output: { value } });
    } else if (
      node.type === "envVar" ||
      node.type === "breakObject" ||
      node.type === "convert" ||
      node.type === "tap"
    ) {
      // Pure data nodes — never appear in an exec chain. Skip silently.
    } else {
      // Unknown node kind — pass through with ok status (forward-compat)
      opts.onStatus(currentId, { status: "ok" });
    }

    // Advance to the next node along exec-out
    const nextId = findNextExecNode(currentId, "exec-out", opts.edges);
    currentId = nextId;
  }
}

/**
 * Emit Event handler.
 *
 *   1. Resolve every payload input pin from upstream
 *   2. Find every On Event node with a matching name
 *   3. For each listener: write the payload values into outputs[listener.id]
 *      so its output pins resolve correctly, then start a runChain from
 *      the listener's `exec-out` and push the (un-awaited) promise into
 *      bgPromises so the top-level runFlow waits for it before returning
 *   4. Continue the main chain immediately (fire-and-forget semantics)
 */
function execEmitEvent(
  node: ExecNode,
  opts: ExecutorOptions,
  outputs: Outputs,
  bgPromises: Promise<void>[],
  tapLogs: TapLogs,
): void {
  const data = (node.data ?? {}) as {
    name?: string;
    payload?: Array<{ key: string; type?: string }>;
  };
  const name = data.name;
  if (!name) {
    opts.onStatus(node.id, { status: "ok" });
    return;
  }

  // Resolve payload values from input pins
  const payloadValues: Record<string, unknown> = {};
  for (const field of data.payload ?? []) {
    const inEdge = opts.edges.find(
      (e) =>
        e.target === node.id &&
        e.data?.kind === "data" &&
        e.targetHandle === `in:${field.key}`,
    );
    if (inEdge) {
      payloadValues[field.key] = resolvePinValue(
        inEdge.source,
        inEdge.sourceHandle ?? "",
        opts,
        outputs,
        tapLogs,
      );
    }
  }

  // Find matching listeners and fire each branch in the background
  const listeners = opts.nodes.filter(
    (n) =>
      n.type === "onEvent" &&
      ((n.data as { name?: string } | undefined)?.name ?? "") === name,
  );

  for (const listener of listeners) {
    // Write payload to listener's outputs so downstream nodes resolve correctly
    outputs[listener.id] = { ...payloadValues };
    opts.onStatus(listener.id, { status: "ok", output: payloadValues });

    const nextId = findNextExecNode(listener.id, "exec-out", opts.edges);
    if (nextId) {
      // Fire and forget — don't await. The promise lives in bgPromises
      // until runFlow's final Promise.allSettled.
      bgPromises.push(runChain(nextId, opts, outputs, bgPromises, tapLogs));
    }
  }

  opts.onStatus(node.id, {
    status: "ok",
    output: { listenerCount: listeners.length, ...payloadValues },
  });
}

/**
 * ForEach iteration. Reads the array input, walks the body sub-chain
 * once per item (sequentially) or all at once (parallel).
 *
 * Per-iteration the node's own outputs (`item`, `index`) are written to
 * the outputs cache so downstream HTTP nodes inside the body see the
 * current item.
 *
 * Parallel mode clones the outputs map per iteration so concurrent body
 * runs don't race on the same node ids.
 */
async function execForEach(
  node: ExecNode,
  opts: ExecutorOptions,
  outputs: Outputs,
  mode: "sequential" | "parallel",
  bgPromises: Promise<void>[],
  tapLogs: TapLogs,
): Promise<void> {
  opts.onStatus(node.id, { status: "running" });

  // Resolve the array input
  const arrayEdge = opts.edges.find(
    (e) =>
      e.target === node.id &&
      e.data?.kind === "data" &&
      e.targetHandle === "in:array",
  );
  if (!arrayEdge) {
    opts.onStatus(node.id, { status: "error", error: "ForEach has no array input connected" });
    throw new Error("ForEach has no array input connected");
  }

  const arrayValue = resolvePinValue(
    arrayEdge.source,
    arrayEdge.sourceHandle ?? "",
    opts,
    outputs,
    tapLogs,
  );

  if (!Array.isArray(arrayValue)) {
    const msg = `ForEach input is not an array (got ${typeof arrayValue})`;
    opts.onStatus(node.id, { status: "error", error: msg });
    throw new Error(msg);
  }

  // Find the body's first node via the exec-body edge
  const bodyStartId = findNextExecNode(node.id, "exec-body", opts.edges);
  // Empty body is allowed (no-op loop) — just iterate without doing anything

  if (mode === "sequential") {
    for (let i = 0; i < arrayValue.length; i++) {
      outputs[node.id] = { item: arrayValue[i], index: i };
      if (bodyStartId) {
        await runChain(bodyStartId, opts, outputs, bgPromises, tapLogs);
      }
    }
  } else {
    // Parallel — each iteration needs its own outputs cache so writes
    // from one body run don't clobber another. tapLogs is shared so
    // every iteration appends to the same per-Tap log.
    await Promise.all(
      arrayValue.map(async (item, i) => {
        const localOutputs: Outputs = {};
        // Inherit upstream values from the parent outputs (so HTTP nodes
        // inside the body can still read EnvVar / outer outputs).
        for (const [k, v] of Object.entries(outputs)) {
          localOutputs[k] = { ...v };
        }
        localOutputs[node.id] = { item, index: i };
        if (bodyStartId) {
          await runChain(bodyStartId, opts, localOutputs, bgPromises, tapLogs);
        }
      }),
    );
  }

  // After all iterations the node's "current" state is the last iteration
  // (sequential) or undefined (parallel). Clear it to avoid surprising
  // downstream consumers reading stale values via exec-out continuations.
  outputs[node.id] = { item: undefined, index: undefined };

  opts.onStatus(node.id, { status: "ok" });
}

/**
 * Find the target node id reachable from `sourceId` via an exec edge with
 * the given source-handle. Returns null if no edge exists.
 */
function findNextExecNode(
  sourceId: string,
  sourceHandle: string,
  edges: ExecEdge[],
): string | null {
  const next = edges.find(
    (e) =>
      e.source === sourceId &&
      e.data?.kind === "exec" &&
      (e.sourceHandle === sourceHandle ||
        // Tolerate unset handles for legacy edges built before exec-body existed
        (sourceHandle === "exec-out" && (e.sourceHandle == null || e.sourceHandle === ""))),
  );
  return next?.target ?? null;
}

/**
 * Execute a single HttpRequest node:
 *   1. Resolve every input pin value from upstream output cache
 *   2. Render the URL / headers / body templates with those values
 *   3. Call the fetch transport
 *   4. Parse the body as JSON (fall back to text on parse error)
 *   5. Validate against the node's Zod schema if one is supplied
 *   6. Project the parsed result into per-pin outputs
 */
async function execHttpNode(
  node: ExecNode,
  edges: ExecEdge[],
  outputs: Outputs,
  opts: ExecutorOptions,
  tapLogs: TapLogs,
): Promise<Record<string, unknown>> {
  const data = (node.data ?? {}) as HttpNodeData;
  const ctx = opts.context ?? {};

  // Step 1: build the input values map.
  // ONLY upstream pin values via data edges. Env vars are no longer
  // injected here — to use an env value, the user must drop an EnvVar
  // node and wire it into the input pin explicitly.
  //
  // Break-Object / Convert / Tap sources are resolved lazily — they're
  // pure-data nodes not in the exec order. We walk back through them to
  // their ultimate cached source.
  const inputValues: Record<string, unknown> = {};
  for (const e of edges) {
    if (e.target !== node.id) continue;
    if (e.data?.kind !== "data") continue;
    if (!e.targetHandle?.startsWith("in:")) continue;

    const pinName = e.targetHandle.slice(3); // "in:userId" → "userId"
    inputValues[pinName] = resolvePinValue(e.source, e.sourceHandle ?? "", opts, outputs, tapLogs);
  }

  // Step 2: render templates and resolve full URL.
  // Base URL: env-level wins, project-level is fallback.
  const baseUrl = ctx.envBaseUrl || ctx.projectBaseUrl || "";
  const renderedUrl = renderTemplate(data.url ?? "", inputValues);
  const url = resolveUrl(renderedUrl, baseUrl);
  const body = data.body ? renderTemplate(data.body, inputValues) : "";

  // Three-layer header merge — last wins per key:
  //   1. project headers (general defaults)
  //   2. environment headers (env-specific overrides)
  //   3. node headers (per-request overrides)
  const headerMap = new Map<string, string>();
  const applyLayer = (layer: ExecContext["projectHeaders"]) => {
    for (const h of layer ?? []) {
      if (h.enabled === false) continue;
      if (!h.key) continue;
      headerMap.set(h.key, renderTemplate(h.value ?? "", inputValues));
    }
  };
  applyLayer(ctx.projectHeaders);
  applyLayer(ctx.envHeaders);
  for (const h of data.headers ?? []) {
    if (h.enabled === false) continue;
    if (!h.key) continue;
    headerMap.set(h.key, renderTemplate(h.value ?? "", inputValues));
  }

  // Step 2b: inject auth from the active environment. Applied AFTER all
  // header merges so auth can't be accidentally overridden by project/env
  // headers.
  let finalUrl = url;
  const auth = ctx.auth;
  if (auth) {
    switch (auth.authType) {
      case "bearer":
        if (auth.bearerToken) headerMap.set("Authorization", `Bearer ${auth.bearerToken}`);
        break;
      case "basic":
        if (auth.basicUsername) {
          const encoded = btoa(`${auth.basicUsername}:${auth.basicPassword ?? ""}`);
          headerMap.set("Authorization", `Basic ${encoded}`);
        }
        break;
      case "apiKey":
        if (auth.apiKeyName && auth.apiKeyValue) {
          if (auth.apiKeyLocation === "query") {
            const sep = finalUrl.includes("?") ? "&" : "?";
            finalUrl = `${finalUrl}${sep}${encodeURIComponent(auth.apiKeyName)}=${encodeURIComponent(auth.apiKeyValue)}`;
          } else {
            headerMap.set(auth.apiKeyName, auth.apiKeyValue);
          }
        }
        break;
      case "oauth2_client_credentials":
        if (auth.oauth2AccessToken) {
          headerMap.set("Authorization", `Bearer ${auth.oauth2AccessToken}`);
        }
        break;
    }
  }
  const headers: Array<[string, string]> = [...headerMap.entries()];

  // Strip body for methods that don't carry one
  const method = (data.method ?? "GET").toUpperCase();
  const sendBody =
    method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && body.length > 0
      ? body
      : null;

  // Step 3: call transport
  const response = await opts.fetch({
    method,
    url: finalUrl,
    headers,
    body: sendBody,
  });

  // Step 4: parse body
  let parsed: unknown;
  try {
    parsed = response.body.length > 0 ? JSON.parse(response.body) : null;
  } catch {
    parsed = response.body;
  }

  // Step 5: validate ONLY on 2xx. On 4xx/5xx we skip validation and let
  // the chain continue — the user can route on the `status` output pin
  // via a Match node to handle errors explicitly.
  if (response.status < 400) {
    const schema = opts.evalSchema(data.responseSchema ?? "");
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new SchemaValidationError(
          `Schema validation failed: ${result.error.message}`,
          parsed,
        );
      }
      parsed = result.data;
    }
  }

  // Step 6: project to output pins. The `status` pin is always set so
  // downstream Match nodes can route on the HTTP status code.
  const out: Record<string, unknown> = { status: response.status };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = v;
    }
  } else {
    out.value = parsed;
  }
  out._request = {
    method,
    url: finalUrl,
    headers: Object.fromEntries(headers),
    status: response.status,
  };
  return out;
}

/**
 * Walk back through the data graph to find the actual value behind a pin.
 *
 * Most pins resolve directly from the output cache. Break-Object / Convert
 * / Tap pins are different: they're pure-data nodes that aren't in the
 * exec order, so they have no cached output of their own. We follow their
 * input edge to find the upstream source and project/coerce/pass-through
 * as needed.
 *
 * Tap nodes are also a debug instrument: when resolved, the executor
 * caches their value AND emits an `ok` status with the captured value as
 * output, so the inspector / node body can show what flowed through.
 *
 * Recursive — supports any chain of pure-data nodes.
 */
function resolvePinValue(
  sourceId: string,
  sourceHandle: string,
  opts: ExecutorOptions,
  outputs: Outputs,
  tapLogs: TapLogs,
): unknown {
  const { nodes, edges } = opts;
  const sourcePin = sourceHandle.replace(/^out:/, "");
  const sourceNode = nodes.find((n) => n.id === sourceId);
  if (!sourceNode) return undefined;

  // Cached value (HTTP/Start/EnvVar/ForEach nodes write here)
  if (outputs[sourceId]?.[sourcePin] !== undefined) {
    return outputs[sourceId][sourcePin];
  }

  // Break-Object: walk back to its source, project the field
  if (sourceNode.type === "breakObject") {
    const inEdge = edges.find(
      (e) =>
        e.target === sourceId &&
        e.data?.kind === "data" &&
        e.targetHandle === "in:object",
    );
    if (!inEdge) return undefined;
    const upstream = resolvePinValue(
      inEdge.source,
      inEdge.sourceHandle ?? "",
      opts,
      outputs,
      tapLogs,
    );
    if (upstream && typeof upstream === "object" && !Array.isArray(upstream)) {
      return (upstream as Record<string, unknown>)[sourcePin];
    }
    return undefined;
  }

  // Convert: walk back to source, coerce to target type
  if (sourceNode.type === "convert") {
    const inEdge = edges.find(
      (e) =>
        e.target === sourceId &&
        e.data?.kind === "data" &&
        e.targetHandle === "in:value",
    );
    if (!inEdge) return undefined;
    const upstream = resolvePinValue(
      inEdge.source,
      inEdge.sourceHandle ?? "",
      opts,
      outputs,
      tapLogs,
    );
    const target = (sourceNode.data as { targetType?: string } | undefined)?.targetType;
    return convertValue(upstream, target);
  }

  // Function: user-authored TS transform. Resolve all declared input
  // pins, execute the code body with `inputs` as the argument, return
  // the requested output field from the result object.
  if (sourceNode.type === "function") {
    const data = sourceNode.data as {
      inputs?: Array<{ key: string }>;
      outputs?: Array<{ key: string }>;
      code?: string;
    };
    // Resolve each declared input pin
    const inputValues: Record<string, unknown> = {};
    for (const field of data.inputs ?? []) {
      if (!field.key) continue;
      const inEdge = edges.find(
        (e) =>
          e.target === sourceId &&
          e.data?.kind === "data" &&
          e.targetHandle === `in:${field.key}`,
      );
      if (inEdge) {
        inputValues[field.key] = resolvePinValue(
          inEdge.source,
          inEdge.sourceHandle ?? "",
          opts,
          outputs,
          tapLogs,
        );
      }
    }
    // Execute the function body in a sandboxed scope
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("inputs", `"use strict";\n${data.code ?? ""}`);
      const result = fn(inputValues);
      // Cache the result for all output pins and return the requested one
      if (result && typeof result === "object") {
        outputs[sourceId] = result as Record<string, unknown>;
        return (result as Record<string, unknown>)[sourcePin];
      }
      outputs[sourceId] = { value: result };
      return sourcePin === "value" ? result : undefined;
    } catch (err) {
      // Surface the error — the node status will show red
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus(sourceId, { status: "error", error: `Function error: ${msg}` });
      return undefined;
    }
  }

  // Make Object: assemble a JS object from each declared field's input
  // edge. Pure data, lazy — only computed when something downstream
  // queries through it.
  if (sourceNode.type === "makeObject") {
    const fields =
      ((sourceNode.data as { fields?: Array<{ key: string; type?: string }> } | undefined)
        ?.fields) ?? [];
    const obj: Record<string, unknown> = {};
    for (const f of fields) {
      if (!f.key) continue;
      const inEdge = edges.find(
        (e) =>
          e.target === sourceId &&
          e.data?.kind === "data" &&
          e.targetHandle === `in:${f.key}`,
      );
      if (!inEdge) {
        obj[f.key] = undefined;
        continue;
      }
      obj[f.key] = resolvePinValue(
        inEdge.source,
        inEdge.sourceHandle ?? "",
        opts,
        outputs,
        tapLogs,
      );
    }
    // The single output pin is "object" — we use the matching pinId here
    return obj;
  }

  // Tap: pass through unchanged, but APPEND the value to the shared
  // tapLogs map so the UI shows the full trace — including every
  // iteration of a parallel ForEach, not just whichever finished last.
  if (sourceNode.type === "tap") {
    const inEdge = edges.find(
      (e) =>
        e.target === sourceId &&
        e.data?.kind === "data" &&
        e.targetHandle === "in:value",
    );
    if (!inEdge) return undefined;
    const upstream = resolvePinValue(
      inEdge.source,
      inEdge.sourceHandle ?? "",
      opts,
      outputs,
      tapLogs,
    );

    // Append to the shared log
    const log = tapLogs.get(sourceId) ?? [];
    log.push(upstream);
    tapLogs.set(sourceId, log);

    // Cache the latest value for downstream consumers (the value flows
    // through unchanged) and report the FULL log to the UI so the node
    // body can show every value, not just the most recent.
    outputs[sourceId] = { value: upstream };
    opts.onStatus(sourceId, {
      status: "ok",
      output: { value: upstream, _log: [...log] },
    });
    return upstream;
  }

  return undefined;
}

/**
 * Coerce a value to the requested target type.
 *
 *   string  → String() for primitives, JSON.stringify() for objects/arrays
 *   number  → Number() — returns NaN if the source isn't parseable
 *   integer → Math.trunc(Number())
 *   boolean → smart parse: "true"/"1" → true, "false"/"0"/"" → false,
 *             else Boolean() (which makes any non-empty string truthy)
 *   json    → JSON.stringify() always
 *
 * Null/undefined pass through unchanged so downstream consumers can detect
 * the absence of input rather than getting "null"/"undefined" strings.
 */
function convertValue(value: unknown, target: string | undefined): unknown {
  if (value === null || value === undefined) return value;

  switch (target) {
    case "string":
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);

    case "number":
      return Number(value);

    case "integer": {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : NaN;
    }

    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const s = value.toLowerCase().trim();
        if (s === "true" || s === "1") return true;
        if (s === "false" || s === "0" || s === "") return false;
        return Boolean(value);
      }
      return Boolean(value);
    }

    case "json":
      return JSON.stringify(value);

    default:
      return value;
  }
}

/**
 * Combine an optional base URL with a (possibly-relative) node URL.
 * If the node URL is absolute (`http://` or `https://`) it overrides the
 * base. Otherwise the base is prepended with a single slash separator.
 */
function resolveUrl(nodeUrl: string, baseUrl?: string): string {
  if (!nodeUrl) return nodeUrl;
  if (/^https?:\/\//i.test(nodeUrl)) return nodeUrl;
  if (!baseUrl) return nodeUrl;

  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = nodeUrl.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}
