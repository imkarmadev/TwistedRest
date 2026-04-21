# Architecture

This document covers how TwistedFlow is built, how the pieces fit together, and where to find things. It's written for maintainers and contributors.

---

## Overview

TwistedFlow is a visual flow engine: users wire nodes on a canvas in a desktop app, then run them locally or compile to standalone binaries via CLI.

```
┌──────────────────────────────────────────────────┐
│              Desktop App (Tauri 2)                │
│  ┌────────────┐         ┌──────────────────────┐ │
│  │  React 19  │ invoke  │    Rust Backend       │ │
│  │  webview   │◄───────►│  (project I/O, HTTP)  │ │
│  │  (canvas,  │ events  │         │              │ │
│  │  inspector)│         │         ▼              │ │
│  └────────────┘         │  twistedflow-engine    │ │
│                         │  (executor, graph,     │ │
│                         │   templates, WASM)     │ │
│                         └──────────────────────┘ │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                      Shared Rust crates                      │
│ twistedflow-engine | twistedflow-builder | twistedflow-project │
│                   twistedflow-plugin-dev                     │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│              CLI (twistedflow-cli)                │
│  run      ──► shared runtime/project logic       │
│  build    ──► twistedflow-builder                │
│  plugin   ──► twistedflow-plugin-dev             │
└──────────────────────────────────────────────────┘
```

The engine crate has **zero Tauri dependency**. The desktop app and CLI both call the same shared Rust logic rather than shelling through each other.

---

## Rust Crates

All Rust code lives under `apps/desktop/src-tauri/`. The workspace contains 8 members:

### `twistedflow` (the Tauri app)

Entry point for the desktop app. Thin shell that wires Tauri to shared project/runtime/build logic.

| File | Role |
|------|------|
| `src/project.rs` | Folder-based project I/O (create, open, save flows, manage .env files) |
| `src/executor_commands.rs` | Tauri commands: `run_flow`, `stop_flow`, `list_node_types`, `build_flow`. Bridges engine to frontend via events. |
| `src/custom_nodes.rs` | Tauri commands for project-local custom node scaffold/build/open |
| `src/http.rs` | reqwest HTTP transport + OAuth2 token management |

### `twistedflow-engine`

The heart. Pure async Rust executor with no framework dependency.

| Module | Role |
|--------|------|
| `executor.rs` | DAG walker. Starts at the Start node, follows exec edges, resolves data pins lazily, streams status events. |
| `graph.rs` | `FlowFile` → `GraphIndex` builder. Indexes nodes/edges for O(1) lookup by ID, exec/data neighbors. |
| `flow_file.rs` | Deserializes `.flow.json` files into `FlowFile` structs (nodes, edges, variables, viewport). |
| `template.rs` | `#{token}` template parser and renderer. Extracts input pin references from node config strings. |
| `node.rs` | `Node` trait, `DataType` enum, `ExecContext`, `StatusEvent`, `LogEntry`, pin definitions, registry builder. |
| `wasm_host.rs` | wasmtime 29 host. Loads `.wasm` plugins from disk, wraps them as `Node` trait objects. |

**Key types:**
- `RunFlowOpts` — everything the executor needs: graph index, context, callbacks, HTTP client, registry, cancellation token
- `NodeResult::Done` vs `NodeResult::Process` — done nodes complete immediately; process nodes spawn a long-running task
- `Outputs` = `HashMap<NodeId, HashMap<PinId, Value>>` — the data cache, filled lazily as nodes execute
- `GraphIndex` — pre-built indexes for fast traversal (exec neighbors, data sources, etc.)

### `twistedflow-nodes`

Built-in node implementations. Each node is a struct with the `#[node]` attribute macro:

```rust
#[node(
    name = "Log",
    type_id = "log",
    category = "Data",
    description = "Log a value to the console",
)]
struct LogNode;

#[async_trait]
impl Node for LogNode {
    async fn execute(&self, ctx: &mut NodeCtx<'_>) -> Result<NodeResult, String> {
        // ...
    }
}
```

The `#[node]` macro generates metadata + `inventory::submit!` for auto-registration. No manual registry — just add a file and `mod` it in `lib.rs`.

### `twistedflow-macros`

The `#[node]` proc macro crate. Parses `name`, `type_id`, `category`, `description` attributes and generates:
- `impl NodeMeta for T` — returns static `NodeMetadata`
- `inventory::submit!(NodeRegistration { ... })` — auto-discovered at startup

### `twistedflow-cli`

CLI binary with three subcommand groups:

- **`run`** — loads a `.flow.json`, builds the graph, runs the executor headlessly. Supports `--env KEY=VAL`, `--base-url`, `--quiet`, `--plugins`.
- **`build`** — compiles a project (folder with `twistedflow.toml`) into a standalone binary via `twistedflow-builder`.
- **`plugin`** — scaffolds and builds custom node crates via `twistedflow-plugin-dev`.

### `twistedflow-builder`

Shared `flow -> standalone binary` build logic used by both the desktop app and CLI.

### `twistedflow-project`

Shared project/runtime helpers:
- validate/find project roots
- ensure `flows/`, `nodes/`, and `nodes-src/` exist
- load runtime node registry from built-ins + `<project>/nodes` + subflows
- list project-local custom node assets

### `twistedflow-plugin-dev`

Shared custom-node authoring helpers used by both the desktop app and CLI:
- scaffold Rust/WASM custom node crates
- extract the guest SDK when needed
- build + validate `.wasm`
- install to `<project>/nodes/`

### `twistedflow-plugin`

Guest SDK for WASM plugin authors. Provides the declarative `nodes!` macro, typed `PluginInputs` / `PluginOutputs` builders, and `host::log` callback. No trait to implement — the macro generates the ABI exports.

---

## Execution Model

### Flow of a Run

1. Frontend calls `invoke("run_flow")` with flow JSON + context (env vars, base URL, headers, auth)
2. Rust deserializes into `FlowFile`, builds `GraphIndex`
3. `build_registry()` collects all `#[node]` implementations via `inventory`
4. Project-local custom nodes loaded from `{project}/nodes/`, added to registry
5. **Variable pre-seeding**: if the flow declares a `variables` array, each variable's default value is written into the runtime variable store before execution begins
6. Executor finds Start node, marks all nodes as pending
7. **Chain walking**: follows exec edges sequentially. At each node:
   - Resolve input data pins by walking backward through data edges (lazy — only computed when needed)
   - Call `node.execute(ctx)` from the registry
   - Store outputs in the shared `Outputs` map
   - Emit status event to frontend
   - Follow the next exec edge
8. **Branching**: If/Else, Match, Try/Catch route to different exec edges based on conditions
9. **Looping**: ForEach nodes recurse into body sub-chains (sequential or parallel via `tokio::join_all`)
10. **Events**: EmitEvent finds all OnEvent listeners by name, spawns their chains concurrently
11. **Process nodes**: Return `NodeResult::Process` — spawned as a separate tokio task that lives until cancellation

### Data Resolution

Data pins are **pull-based**. When node B needs input from node A:
1. Executor traces the data edge backward from B's input pin to A's output pin
2. If A has already executed, reads from `Outputs` cache
3. If A is a pure-data node (Convert, BreakObject, Tap, EnvVar), executes it on-demand and caches
4. Templates (`#{token}`) in node config are resolved the same way

### Process Nodes

Some nodes (HTTP Listen) need to stay alive beyond their exec chain. These return `NodeResult::Process` and are tracked in a separate process registry. They run until:
- The user clicks Stop
- The flow completes and cleanup runs
- `CancellationToken` is cancelled

---

## Frontend Architecture

### React App (`apps/desktop/src/mainview/`)

Single-page app rendered in Tauri's webview. No router — it's a single canvas-first workspace with overlays.

| Directory | Role |
|-----------|------|
| `components/canvas/` | React Flow canvas, node components (one `.tsx` per node type), edge renderers, palette |
| `components/inspector/` | Right-side property editor — context-sensitive per selected node type |
| `components/workspace/` | Bottom workspace tabs for Flows, Subflows, Custom Nodes, Console, Problems |
| `components/settings/` | Project settings modal (name, environments) |
| `components/layout/` | Top project bar / drag region |
| `components/editor/` | Code editor component |
| `lib/` | Shared logic — pin system, schema resolution, node registry, etc. |

### Pin System

Every node declares its pins via `compute*Pins()` functions in `lib/node-pins.ts`. Pins have:
- `id` — handle identifier (e.g. `in:userId`, `out:name`, `exec-in`)
- `kind` — `exec` or `data`
- `direction` — `in` or `out`
- `dataType` — `string | number | boolean | object | array | unknown`

Schema resolution (`lib/schema-resolution.ts`) walks backward through the graph to introspect pin types at design time — used by BreakObject (auto-generate sub-pins from objects, including Get Variable nodes with declared object types), Convert (filter valid targets), and the palette (filter compatible nodes on pin-drop).

### Communication with Rust

- `invoke("run_flow", { ... })` — start execution
- `invoke("stop_flow")` — cancel via CancellationToken
- `listen("flow:status")` — per-node status updates (pending/running/ok/error)
- `listen("flow:log")` — log entries from Log/Print nodes
- `invoke("save_flow", { ... })`, `invoke("open_project", { ... })`, `invoke("list_flows", { ... })` — project I/O
- `invoke("create_custom_node_source")`, `invoke("build_custom_node")` — desktop custom-node authoring

### JS Packages

- **`@twistedflow/core`** — `pinsFromSchema`, `parseTemplate`, `inputPinsFor`, Zod schema eval. Used for canvas rendering only, **not execution**.
- **`@twistedflow/shared`** — shared TypeScript types.

---

## Project Model

Projects are folders. No database.

```
my-project/
├── twistedflow.toml      # name = "My Project"
├── .env                   # default environment
├── .env.dev               # dev environment
├── .env.prod              # prod environment
├── flows/
│   ├── main.flow.json     # flow definitions (nodes, edges, viewport)
│   └── health-check.flow.json
├── nodes/                 # built/installed project-scoped .wasm custom nodes
│   └── my-custom-node.wasm
└── nodes-src/             # optional editable Rust source for those nodes
    └── my-custom-node/
        ├── Cargo.toml
        └── src/lib.rs
```

- **Environments** = `.env` files in standard dotenv format
- **Flows** = JSON files with nodes array, edges array, optional `variables` array (typed declarations with defaults), and viewport position
- **Custom nodes** = `.wasm` files in `nodes/`, with optional editable Rust sources in `nodes-src/`

---

## WASM Plugin System

Custom nodes extend TwistedFlow with custom node types distributed as `.wasm` files.

**Loading order:**
1. Built-in nodes from `twistedflow-nodes`
2. Project custom nodes from `{project}/nodes/`
3. Project subflows from `{project}/flows/*.flow.json` with `kind = "subflow"`

**Runtime:** wasmtime 29. The engine's `wasm_host.rs` loads each `.wasm`, wraps it as a `Box<dyn Node>`, and adds it to the registry alongside built-in nodes.

**Writing custom nodes:** Use the `twistedflow-plugin` guest SDK with its declarative `nodes!` macro. Target `wasm32-wasip1`. Either use the desktop app's **Custom Nodes** tab or run `twistedflow plugin new <name>` + `twistedflow plugin build`. Both call the same shared Rust implementation. Host callbacks available: `host::log` routes to the Console tab. See [docs/plugins.md](docs/plugins.md) for the full guide.

---

## Build System

### Development

```bash
bun install          # JS dependencies
cd apps/desktop
bun run dev          # Vite HMR + Cargo watch
```

### Release

```bash
bun run release patch   # bumps all versions, commits, tags, pushes
```

GitHub Actions picks up the tag and builds:
- macOS ARM (.app + .dmg)
- macOS Intel (.app + .dmg)
- Linux x64 (.AppImage + .deb)

### CLI Binary

The CLI is built as part of the Cargo workspace. `twistedflow-cli build` is a thin wrapper over `twistedflow-builder`, which compiles flows into standalone binaries by generating a wrapper `main.rs` that embeds the flow JSON + env vars and links against `twistedflow-engine`.

---

## Design Principles

1. **UX over architecture** — if users have to think about plumbing, the abstraction is wrong. Direct pin wiring over indirection.
2. **Files, not databases** — projects are folders, environments are `.env` files, flows are JSON. Git-native.
3. **Rust for execution, JS for rendering** — the frontend only draws the canvas. All execution happens in Rust.
4. **Convention over configuration** — `#[node]` macro + inventory handles registration. Drop a file, add a `mod`, done.
5. **Ship the happy path** — get it working, fix edge cases as they come.
