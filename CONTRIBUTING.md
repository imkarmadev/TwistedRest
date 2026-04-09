# Contributing to TwistedRest

Thanks for your interest in contributing! TwistedRest is an open-source visual API workflow builder, and we welcome contributions of all kinds — bug reports, feature ideas, code, docs, and example flows.

## Getting Started

### Prerequisites

- **macOS** or **Linux** (Windows not yet supported)
- [Bun](https://bun.sh/) >= 1.2
- [Rust](https://rustup.rs/) >= 1.77
- Xcode Command Line Tools on macOS (`xcode-select --install`)

### Setup

```bash
git clone https://github.com/imkarmadev/TwistedRest.git
cd TwistedRest
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
cd packages/core && bun test   # just the core tests
bun test --watch          # watch mode
```

### Typecheck

```bash
bun run typecheck         # all packages
```

## Project Structure

```
TwistedRest/
├── apps/
│   ├── desktop/              # Tauri desktop app
│   │   ├── src-tauri/        # Rust backend (SQLite, HTTP, OAuth2)
│   │   └── src/mainview/     # React frontend
│   └── web/                  # Landing page (static HTML)
├── packages/
│   ├── core/                 # Executor, templates, schemas, tests
│   └── shared/               # Zod domain models
├── examples/                 # Importable .flow.json files
└── scripts/                  # Release tooling
```

## How to Contribute

### Bug Reports

Open an [issue](https://github.com/imkarmadev/TwistedRest/issues) with:
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
3. **Add tests** if you're touching `packages/core` (executor, templates, schemas)
4. **Run `bun run test && bun run typecheck`** to verify nothing breaks
5. **Open a PR** with a clear description of what and why

### Adding a New Node Type

This is the most common type of contribution. Here's the checklist:

1. **Component** — `apps/desktop/src/mainview/components/canvas/nodes/your-node.tsx`
2. **Pin computer** — add `computeYourNodePins()` in `lib/node-pins.ts`
3. **Registry entry** — add to `lib/node-registry.ts` (label, category, description, pin flags, factory)
4. **Inspector editor** — add a section in `components/inspector/inspector-panel.tsx`
5. **Executor handler** — add a case in `packages/core/src/executor.ts` (in `runChain` for exec nodes, or `resolvePinValue` for pure-data nodes)
6. **Schema resolution** — if the node has typed outputs, add a case in `lib/schema-resolution.ts`
7. **CSS** — header gradient + badge in `nodes/node.module.css`
8. **collectPinIds + KNOWN_TYPES** — update both in `flow-canvas.tsx`
9. **Tests** — add at least one test in `packages/core/src/executor.test.ts`

### Contributing Example Flows

Example flows live in `/examples` as `.flow.json` files. They're importable via the sidebar's "+ import" button.

To create one:
1. Build the flow in TwistedRest
2. Export it (click the ↓ icon on the flow in the sidebar)
3. Rename the file descriptively (e.g., `github-pr-checker.flow.json`)
4. Add it to `/examples` via PR

Good examples:
- Exercise multiple node types
- Solve a real-world use case (check CI status, monitor an API, chain microservices)
- Include meaningful node labels and a clear layout
- Work with free/public APIs (so anyone can run them)

## Code Style

- **TypeScript** — strict mode, no `any` unless necessary
- **CSS Modules** — `.module.css` files, design tokens from `app.css`
- **No Tailwind** — we use CSS custom properties + CSS Modules
- **Imports** — workspace packages via `@twistedrest/core`, `@twistedrest/shared`
- **Rust** — standard `rustfmt` formatting

## Release Process

Releases are automated via `bun run release`:

```bash
bun run release patch    # 0.2.0 → 0.2.1
bun run release minor    # 0.2.0 → 0.3.0
bun run release major    # 0.2.0 → 1.0.0
```

This bumps versions across all config files, commits, tags, and pushes. GitHub Actions builds the binaries and attaches them to the release.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
