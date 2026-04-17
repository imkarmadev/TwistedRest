# TwistedFlow

A visual flow engine. Build automations, API clients, HTTP servers, test suites, and system tools by wiring nodes on a canvas — then run them headlessly or compile to standalone binaries.

**Desktop app** (Tauri 2 + React 19 + Rust) + **CLI** (`twistedflow-cli run` / `twistedflow-cli build`).

---

## Features

### 46 Built-in Nodes

| Node | Category | Description |
|------|----------|-------------|
| **Start** | Flow Control | Entry point. Triggers execution. |
| **If/Else** | Flow Control | Boolean branching — true/false exec paths. |
| **Match** | Flow Control | Switch/case routing on any value. |
| **ForEach (Sequential)** | Flow Control | Iterates an array, runs body chain once per item in order. |
| **ForEach (Parallel)** | Flow Control | Iterates an array, runs all items concurrently. |
| **Try/Catch** | Flow Control | Error boundary — catches failures and routes to error path. |
| **Retry** | Flow Control | Retry a sub-chain with exponential backoff. |
| **EmitEvent** | Flow Control | Broadcasts a named event. Listeners fire in parallel. |
| **OnEvent** | Flow Control | Listens for a named event. |
| **Request** | HTTP | HTTP calls with URL templates, auth, Zod schema, response time tracking. |
| **Listen** | HTTP Server | Starts an HTTP server (process node — stays alive). |
| **Route** | HTTP Server | Multi-route dispatcher with path params (`/users/:id`) and query parsing. |
| **Send Response** | HTTP Server | Sends HTTP response with dynamic headers. |
| **Parse Body** | HTTP Server | Parse request body (JSON, form-urlencoded, text). Auto-detects Content-Type. |
| **Set Headers** | HTTP Server | Build response headers with `#{template}` support. |
| **CORS** | HTTP Server | Handle CORS preflight and inject Access-Control headers. |
| **Verify Auth** | HTTP Server | Validate JWT (HS256), API key, Basic auth. Branches pass/fail. |
| **Rate Limit** | HTTP Server | Sliding window rate limiter with per-key tracking. |
| **Cookie** | HTTP Server | Parse incoming cookies or build Set-Cookie headers. |
| **Redirect** | HTTP Server | Send HTTP redirect (301/302/307/308). |
| **Serve Static** | HTTP Server | Serve files from disk with MIME detection. |
| **Route Match** | HTTP Server | *(Deprecated)* Basic method + path matching. Use Route instead. |
| **BreakObject** | Data | Splits an object into one output pin per field. |
| **MakeObject** | Data | Assembles an object from named typed input pins. |
| **Convert** | Data | Type coercion (string/number/integer/boolean/JSON). |
| **Tap** | Data | Pass-through debug probe. Shows every value that flows through. |
| **Log** | Data | Exec-chain print sink. Writes to the console panel. |
| **Filter** | Data | Filter array items by expression (`item.status == 200`). |
| **Map** | Data | Transform array items — pluck, pick, or template. |
| **Merge** | Data | Deep-merge objects or concatenate arrays. |
| **Reduce** | Data | Aggregate arrays: sum, count, join, min, max, groupBy. |
| **Function** | Data | Custom TypeScript transform with typed I/O. |
| **EnvVar** | Variables | Reads a value from the active .env file. |
| **SetVariable** | Variables | Sets a runtime variable. |
| **GetVariable** | Variables | Reads a runtime variable. |
| **Print** | System | Writes to stdout (useful in CLI/binary mode). |
| **ShellExec** | System | Runs a shell command and captures output. |
| **FileRead** | System | Reads a file from disk. |
| **FileWrite** | System | Writes a file to disk. |
| **Sleep** | System | Pauses execution for a duration. |
| **Exit** | System | Exits the flow with a status code. |
| **Parse Args** | CLI | Parse CLI arguments into flags and positional args. |
| **Stdin** | CLI | Read from standard input (piped or interactive). |
| **Stderr** | CLI | Write to stderr. |
| **Prompt** | CLI | Interactive user input (text, confirm, password). |
| **Regex** | String | Match, extract, replace, or split with regular expressions. |
| **Template** | String | String interpolation with `#{var}` tokens. |
| **Encode/Decode** | String | Base64, URL, hex encoding/decoding. |
| **Hash** | String | SHA-256, SHA-512, MD5, HMAC-SHA256. |
| **Assert** | Testing | Asserts a condition is true (fails the flow if not). |
| **AssertType** | Testing | Asserts a value matches an expected type. |

### Two Edge Types

- **Exec edges** (white diamonds) — control flow. Determines run order.
- **Data edges** (colored circles) — typed values. Pin colors: string (pink), number (green), boolean (red), object (blue), array (purple).

### CLI + Compile to Binary

Download `twistedflow-cli` from [GitHub Releases](https://github.com/imkarmadev/TwistedFlow/releases) — each release includes `twistedflow-cli-<platform>.tar.gz` for macOS (ARM + Intel) and Linux (x64).

```bash
# Install (macOS Apple Silicon example)
tar -xzf twistedflow-cli-aarch64-apple-darwin.tar.gz
sudo mv twistedflow-cli /usr/local/bin/twistedflow

# Run a flow headlessly
twistedflow run ./flows/main.flow.json -e API_KEY=abc123

# Compile a project to a standalone binary
twistedflow build ~/my-project -o my-app --flow main --env prod
./my-app   # just runs, no args needed
```

The desktop app also has a **Build** button in the canvas toolbar that compiles via native save dialog.

### WASM Plugins

Custom nodes written in Rust, compiled to WebAssembly. One command scaffolds, builds, and installs:

```bash
twistedflow plugin new my-plugin --category Utility --node Hello
cd my-plugin
twistedflow plugin build
```

The guest SDK (`twistedflow-plugin` crate) exposes a `nodes!` macro — no manual ABI wiring. Plugins support multi-input/output nodes, typed pins (`string`, `number`, `boolean`, `object`, `array`), and `host::log` callbacks that route into the TwistedFlow console.

See the [plugin author guide](./docs/plugins.md) and [examples](./examples/plugins) (`text-utils`, `json-tools`).

### Folder-based Projects

No database. A project is just files on disk — git-friendly by default.

```
my-project/
├── twistedflow.toml     # project name
├── .env                 # default environment
├── .env.dev             # dev environment
├── .env.prod            # prod environment
├── flows/
│   └── main.flow.json
└── nodes/               # project WASM plugins
```

### Smart Canvas

- **Right-click** or **Space** to open the searchable node palette
- **Drag a pin to empty canvas** — palette opens filtered to compatible nodes, auto-wires on selection
- **Type-aware filtering** — dragging a number pin won't suggest Break Object (which needs an object)
- **Viewport persistence** — zoom/pan position saved per flow
- **Minimap** — toggle with **M** key

### Debugging

- **Tap nodes** show every value that passed through (inline on the canvas)
- **Log nodes** print to the **Console panel** (toggle with **`** backtick key)
- **Per-node status** — pending (grey), running (pulsing cyan), ok (green), error (red)
- **Last Response viewer** in the inspector
- **Stop button** — halts execution at the next node boundary

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Execution | Rust (async, pure — no Tauri dependency) |
| HTTP | [reqwest](https://github.com/seanmonstar/reqwest) |
| WASM runtime | [wasmtime](https://wasmtime.dev/) 29 |
| Frontend | React 19 + [Vite 6](https://vitejs.dev/) |
| Canvas | [@xyflow/react](https://reactflow.dev/) v12 |
| Monorepo | [Turbo](https://turbo.build/) + [Bun](https://bun.sh/) |

### Monorepo Structure

```
TwistedFlow/
├── apps/
│   ├── desktop/                    # Tauri desktop app
│   │   ├── src-tauri/              # Rust workspace
│   │   │   ├── src/                # Tauri app (project.rs, executor_commands.rs, http.rs)
│   │   │   └── crates/
│   │   │       ├── twistedflow-engine/   # Pure async executor, graph, templates, WASM host
│   │   │       ├── twistedflow-nodes/    # 46 built-in node implementations (#[node] macro)
│   │   │       ├── twistedflow-macros/   # #[node] proc macro + inventory auto-registration
│   │   │       ├── twistedflow-cli/      # CLI binary (run + build)
│   │   │       └── twistedflow-plugin/   # Guest SDK for WASM plugin authors
│   │   └── src/mainview/           # React frontend
│   │       ├── components/canvas/  # Node renderers + flow canvas
│   │       ├── components/inspector/ # Property editor
│   │       ├── components/console/ # Log panel
│   │       ├── components/settings/ # Project settings
│   │       └── lib/                # Pin system, schema resolution, node registry
│   └── web/                        # Landing page
├── packages/
│   ├── core/                       # JS utilities (pin helpers, template parser, schema tools)
│   └── shared/                     # Shared TypeScript types
├── examples/                       # Importable .flow.json files
└── scripts/                        # Release tooling
```

---

## Getting Started

### Prerequisites

- **macOS** or **Linux** (Windows not yet supported)
- [Bun](https://bun.sh/) >= 1.2
- [Rust](https://rustup.rs/) >= 1.77
- Xcode Command Line Tools on macOS (`xcode-select --install`)

### Install (Release)

Download the desktop app and CLI from [GitHub Releases](https://github.com/imkarmadev/TwistedFlow/releases):
- **Desktop app:** `.dmg` (macOS) or `.AppImage`/`.deb` (Linux)
- **CLI:** `twistedflow-cli-<platform>.tar.gz` — extract and move to your PATH:

```bash
tar -xzf twistedflow-cli-aarch64-apple-darwin.tar.gz
sudo mv twistedflow-cli /usr/local/bin/twistedflow
```

### From Source (Development)

```bash
git clone https://github.com/imkarmadev/TwistedFlow.git
cd TwistedFlow
bun install

cd apps/desktop
bun run dev
```

First Rust compile takes ~30s. Subsequent rebuilds are <5s.

To build the CLI from source:

```bash
cd apps/desktop/src-tauri
cargo build --release -p twistedflow-cli
# Binary: target/release/twistedflow-cli
```

### Run Tests

```bash
bun run test              # all packages via Turbo
cd packages/core && bun test   # just core JS tests
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
| **Cmd+Z / Cmd+Shift+Z** | Undo / Redo |

---

## License

MIT
