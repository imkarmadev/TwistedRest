# Contributing to TwistedFlow

Thanks for your interest in contributing! TwistedFlow is an open-source visual flow engine, and we welcome contributions of all kinds — bug reports, feature ideas, code, docs, and example flows.

## Getting Started

### Prerequisites

- **macOS** or **Linux** (Windows not yet supported)
- [Bun](https://bun.sh/) >= 1.2
- [Rust](https://rustup.rs/) >= 1.77
- Xcode Command Line Tools on macOS (`xcode-select --install`)

### Setup

```bash
git clone https://github.com/imkarmadev/TwistedFlow.git
cd TwistedFlow
bun install
```

### Run in Dev Mode

```bash
cd apps/desktop
bun run dev
```

First Rust compile takes ~30s. Subsequent rebuilds are <5s. Vite provides HMR for the frontend; Cargo watches and recompiles the Rust backend on file changes.

### Run Tests

```bash
bun run test              # all packages via Turbo
cd packages/core && bun test   # just core JS tests
bun test --watch          # watch mode
```

### Typecheck

```bash
bun run typecheck         # all packages
```

## Project Structure

```
TwistedFlow/
├── apps/
│   ├── desktop/                    # Tauri desktop app
│   │   ├── src-tauri/              # Rust workspace
│   │   │   ├── src/                # Tauri app shell (commands, project I/O, HTTP bridge)
│   │   │   └── crates/
│   │   │       ├── twistedflow-engine/   # Pure async executor, graph, templates, WASM host
│   │   │       ├── twistedflow-nodes/    # Built-in nodes via #[node] macro
│   │   │       ├── twistedflow-macros/   # #[node] proc macro + inventory registration
│   │   │       ├── twistedflow-cli/      # CLI binary (run + build + plugin)
│   │   │       ├── twistedflow-builder/  # Shared flow binary build logic
│   │   │       ├── twistedflow-project/  # Shared project/runtime helpers
│   │   │       ├── twistedflow-plugin-dev/ # Shared custom-node scaffold/build helpers
│   │   │       └── twistedflow-plugin/   # Guest SDK for WASM plugin authors
│   │   └── src/mainview/           # React frontend
│   └── web/                        # Landing page (static HTML)
├── packages/
│   ├── core/                       # JS utilities (pin helpers, template parser, schema tools)
│   └── shared/                     # Shared TypeScript types
├── examples/                       # Importable .flow.json files
└── scripts/                        # Release tooling
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a deep dive into how everything fits together.

## How to Contribute

### Bug Reports

Open an [issue](https://github.com/imkarmadev/TwistedFlow/issues) with:
- What you expected
- What actually happened
- Steps to reproduce
- A screenshot if it's visual

### Feature Requests

Open an issue with:
- The use case (what are you trying to do?)
- Your proposed solution (how should it work?)
- Alternatives you considered

### Code Contributions

1. **Fork** the repo and create a branch from `main`
2. **Make your changes** — keep commits focused and descriptive
3. **Add tests** if you're touching execution logic
4. **Run `bun run test && bun run typecheck`** to verify nothing breaks
5. **Open a PR** with a clear description of what and why

### Adding a New Node Type

Nodes have two halves: a Rust implementation (execution) and a React component (rendering).

#### Rust side (execution)

1. **Node file** — create `crates/twistedflow-nodes/src/your_node.rs`
2. **Use the `#[node]` macro** — it auto-registers via `inventory`. Define `metadata()` (name, category, pins) and `execute()`.
3. **Re-export** — add `mod your_node;` in `crates/twistedflow-nodes/src/lib.rs`
4. That's it — the macro + inventory system handles registration automatically.

#### Frontend side (rendering)

1. **Component** — `apps/desktop/src/mainview/components/canvas/nodes/your-node.tsx`
2. **Pin computer** — add `computeYourNodePins()` in `lib/node-pins.ts`
3. **Registry entry** — add to `lib/node-registry.ts` (label, category, description, pin flags, factory)
4. **Inspector editor** — add a section in `components/inspector/inspector-panel.tsx` if the node has editable config
5. **Schema resolution** — if the node has typed outputs, add a case in `lib/schema-resolution.ts`
6. **CSS** — header gradient + badge in `nodes/node.module.css`

#### Verify

- Create a test flow in `~/Desktop/test-project/flows/` that exercises the node
- Test in the desktop app and via `twistedflow-cli run`

### Adding a WASM Custom Node

For nodes distributed as project-local custom nodes (not built-in):

1. Create a Rust project that depends on `twistedflow-plugin`, or use `twistedflow plugin new`
2. Define nodes with the `nodes!` macro
3. Compile to `.wasm`
4. Install into `{project}/nodes/` (desktop and CLI both support this directly)

See `examples/plugins/` for a reference.

### Contributing Example Flows

Example flows live in `/examples` as `.flow.json` files. Copy them into a project's `flows/` directory, then open them from the **Flows** tab in the desktop app.

Good examples:
- Exercise multiple node types
- Solve a real-world use case (check CI status, monitor an API, chain microservices)
- Include meaningful node labels and a clear layout
- Work with free/public APIs (so anyone can run them)

## Code Style

- **Rust** — `rustfmt`, standard Rust conventions. Execution logic goes in crates, not the Tauri app.
- **TypeScript** — strict mode, no `any` unless necessary
- **CSS Modules** — `.module.css` files, design tokens from `app.css`
- **No Tailwind** — we use CSS custom properties + CSS Modules
- **Imports** — workspace packages via `@twistedflow/core`, `@twistedflow/shared`

## Release Process

Releases are automated via `bun run release`:

```bash
bun run release patch    # 1.0.0 -> 1.0.1
bun run release minor    # 1.0.0 -> 1.1.0
bun run release major    # 1.0.0 -> 2.0.0
```

This bumps versions across all config files, commits, tags, and pushes. GitHub Actions builds the binaries and attaches them to the release.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
