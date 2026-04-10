# TwistedFlow

A visual API workflow builder. Visual node-based flow programming. Build, chain, and debug HTTP request flows by wiring nodes on a canvas — no code required for most workflows, with a Function node escape hatch when you need custom logic.

**macOS desktop app** built with Tauri 2 + React 19 + React Flow + Rust + SQLite.

---

## Features

### Node Types

| Node | Category | Description |
|------|----------|-------------|
| **Start** | Flow Control | Entry point. Environment selector + Run/Stop buttons. |
| **HTTP Request** | HTTP | Fires HTTP calls. URL templates (`#{token}`), Zod response schema, status code output pin. |
| **Match** | Flow Control | Switch/case routing. Compares a value against cases, fires the matching branch. |
| **ForEach (Sequential)** | Flow Control | Iterates an array, runs body chain once per item in order. |
| **ForEach (Parallel)** | Flow Control | Iterates an array, runs body chain for all items concurrently. |
| **Emit Event** | Events | Broadcasts a named event with typed payload. Listeners fire in parallel. |
| **On Event** | Events | Listens for a named event. Output pins auto-mirror the emitter's payload. |
| **Env Var** | Variables | Reads a value from the active environment. Explicit wiring, no hidden template magic. |
| **Break Object** | Data | Splits an object into one output pin per field. Introspects source schema at design time. |
| **Make Object** | Data | Assembles an object from named typed input pins. Inverse of Break Object. |
| **Convert** | Data | Type coercion (string/number/integer/boolean/JSON). Smart — detects source type, filters valid targets. |
| **Function** | Data | User-authored TypeScript transform. Typed inputs/outputs, sandboxed execution. |
| **Tap** | Data | Pass-through debug probe. Shows every value that flows through it. Accumulates across parallel iterations. |
| **Log** | Data | Exec-chain print sink. Writes values to the bottom Console panel with timestamps. |

### Two Edge Types (Visual)

- **Exec edges** (white diamonds) — control flow. Determines run order.
- **Data edges** (colored circles) — typed values. Pin colors: string (pink), number (green), boolean (red), object (blue), array (purple).

### Environments + Auth

Each project has named environments (dev, staging, prod) with:

- **Base URL** — prepended to relative request URLs
- **Headers** — env-specific headers (override project defaults)
- **Variables** — accessed via explicit EnvVar nodes on the canvas
- **Authentication** — Bearer, Basic, API Key (header or query), OAuth2 Client Credentials

Auth is injected after all header merges — can't be accidentally overridden.

### Smart Canvas

- **Right-click** or **Space** to open the searchable node palette
- **Drag a pin to empty canvas** — palette opens filtered to compatible nodes, auto-wires on selection
- **Type-aware filtering** — dragging a number pin won't suggest Break Object (which needs an object)
- **Pin hit detection** — connection drops near a node don't hijack to the palette
- **Viewport persistence** — zoom/pan position saved per flow
- **Minimap** — toggle with **M** key

### Debugging

- **Tap nodes** show every value that passed through (inline on the canvas)
- **Log nodes** print to the **Console panel** (toggle with **`** backtick key)
- **Per-node status** — pending (grey), running (pulsing cyan), ok (green), error (red)
- **Last Response viewer** in the inspector — shows the actual HTTP request sent (resolved URL + all headers including auth) and the response body
- **Schema validation errors** show full Zod error + a "Use response as schema" one-click fix
- **Stop button** — halts execution at the next node boundary

### Schema Authoring

- **Hand-write** Zod schemas in the inspector
- **From JSON** — paste a sample response, auto-generate the Zod schema
- **Auto-fix** — when validation fails, click "Use response as schema" to regenerate from the actual response

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Backend | Rust + [rusqlite](https://github.com/rusqlite/rusqlite) + [reqwest](https://github.com/seanmonstar/reqwest) |
| Frontend | React 19 + [Vite 6](https://vitejs.dev/) |
| Canvas | [@xyflow/react](https://reactflow.dev/) v12 (React Flow) |
| Schema | [Zod 3](https://zod.dev/) |
| Monorepo | [Turbo](https://turbo.build/) + [Bun](https://bun.sh/) |
| Testing | bun:test (64 tests) |

### Monorepo Structure

```
twistedflow/
├── apps/desktop/                # Tauri desktop app
│   ├── src-tauri/               # Rust backend (SQLite, HTTP, OAuth2)
│   │   ├── src/main.rs          # Entry
│   │   ├── src/lib.rs           # Tauri setup
│   │   ├── src/db.rs            # SQLite repos (Project, Flow, Environment)
│   │   ├── src/commands.rs      # Tauri commands (CRUD + save/load)
│   │   └── src/http.rs          # reqwest transport + OAuth2 CC
│   ├── src/mainview/            # React app
│   │   ├── App.tsx              # Root layout + state
│   │   ├── use-tauri.ts         # Tauri invoke bridge
│   │   ├── components/canvas/   # React Flow canvas + node renderers
│   │   ├── components/inspector/# Right-side property editor
│   │   ├── components/console/  # Bottom log panel
│   │   ├── components/settings/ # Project settings modal
│   │   ├── components/layout/   # Sidebar + title bar
│   │   └── lib/                 # Shared logic (pins, schema, context)
│   └── package.json
├── packages/
│   ├── core/                    # Executor, template engine, schema tools
│   │   ├── src/executor.ts      # Recursive chain walker + all node handlers
│   │   ├── src/template.ts      # #{token} parser + renderer
│   │   ├── src/schema/walk.ts   # Zod schema → pin descriptors
│   │   ├── src/schema/from-json.ts  # JSON → Zod source inference
│   │   └── src/*.test.ts        # 64 unit tests
│   └── shared/                  # Zod domain models
│       └── src/models/          # Project, Flow, Node, Edge, Environment
├── package.json                 # Root workspace config
├── turbo.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- **macOS** (Tauri window chrome + native traffic lights)
- [Bun](https://bun.sh/) >= 1.2
- [Rust](https://rustup.rs/) >= 1.77
- Xcode Command Line Tools (`xcode-select --install`)

### Install + Run

```bash
# Clone
git clone https://github.com/imkarmadev/TwistedFlow.git
cd twistedflow

# Install JS dependencies
bun install

# Run in dev mode (Vite HMR + Cargo watch)
cd apps/desktop
bun run dev
```

First Rust compile takes ~30s (downloads + builds crates). Subsequent rebuilds are <5s.

### Run Tests

```bash
# From root — runs all packages via Turbo
bun run test

# Just the core package
cd packages/core && bun test

# Watch mode
cd packages/core && bun test --watch
```

### Build for Release

```bash
cd apps/desktop
bun run build
```

Produces a `.app` bundle in `src-tauri/target/release/bundle/`.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Right-click** | Open node palette at cursor |
| **Space** | Open node palette at center |
| **`** (backtick) | Toggle console panel |
| **M** | Toggle minimap |
| **Backspace / Delete** | Delete selected node or edge |
| **Cmd+Z / Cmd+Shift+Z** | Undo / Redo (React Flow built-in) |

---

## Data Storage

- **SQLite database** at `~/Library/Application Support/dev.twistedflow.desktop/twistedflow.db`
- Schema uses UUIDs + `updated_at` + soft-delete columns — designed for future cloud sync
- Flows store nodes, edges, and viewport as JSON columns

---

## Architecture Highlights

### Executor (packages/core/executor.ts)

The heart of the app. A recursive chain walker that:

1. Starts at the Start node
2. Follows exec edges to determine run order
3. For each HTTP node: resolves `#{token}` templates from upstream data edges, applies auth + header layering, fires fetch via Rust, validates response against Zod schema
4. ForEach nodes recurse into the body sub-chain (sequential or parallel via `Promise.all`)
5. Match nodes route to the matching case branch and return (no continuation)
6. Emit Event nodes find all On Event listeners by name and spawn their branches concurrently
7. Pure-data nodes (Convert, Break Object, Make Object, Function, Tap) resolve lazily when downstream nodes query through them
8. Log nodes call the `onLog` callback to push entries to the console panel

All of this is tested with 64 unit tests using a mock fetch transport.

### Pin System

Every node declares its pins via a `compute*Pins()` function. Pins have:
- `id` — handle identifier (e.g. `in:userId`, `out:name`, `exec-in`)
- `kind` — `exec` or `data`
- `direction` — `in` or `out`
- `dataType` — `string | number | boolean | object | array | unknown`

The schema-resolution system (`lib/schema-resolution.ts`) walks backward through the graph to introspect what type a given pin carries — used by Break Object (to auto-generate sub-pins), Convert (to filter valid targets), and the palette (to filter compatible nodes on pin-drop).

### Three-Layer Header Merge

Every HTTP request's headers are built by merging three layers (last wins per key):
1. **Project default headers** — general, same across environments
2. **Environment headers** — env-specific overrides
3. **Node headers** — per-request overrides

Auth is applied AFTER all three layers — can't be accidentally overridden.

---

## License

MIT
