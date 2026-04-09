# Changelog

All notable changes to TwistedRest are documented here.

## [0.2.0] — 2026-04-09

### Added
- **14 node types**: Start, HTTP Request, Match, ForEach (Sequential), ForEach (Parallel), Emit Event, On Event, Env Var, Break Object, Make Object, Convert, Function, Tap, Log
- **Blueprint-style canvas** with exec edges (white diamonds) and data edges (colored circles)
- **Searchable node palette** — right-click, Space, or drag a pin to empty canvas with type-aware filtering
- **Environments** with per-env base URL, headers, variables, and auth
- **Authentication** — Bearer, Basic, API Key (header/query), OAuth2 Client Credentials, OAuth2 Authorization Code (browser login flow)
- **Match node** — switch/case routing on any value including HTTP status codes
- **Event system** — Emit/On Event for decoupled pub/sub with typed payloads
- **Console panel** — bottom log viewer, toggle with backtick key
- **Inspector** — right-side property editor with Zod schema validation, "From JSON" inference, "Use response as schema" auto-fix, copy as curl
- **HTTP status code as output pin** — route on 200/404/500 via Match without halting the chain
- **Import/Export** — flows as .flow.json files
- **Flow management** — create, delete, duplicate, export
- **Project settings** — name, default headers, environments with auth
- **Smart Convert** — detects source type, filters valid target conversions
- **Tap node** — debug pass-through showing values inline, accumulates across parallel iterations
- **Log node** — exec-chain print sink to console panel
- **Make Object** — assemble objects from named typed fields (inverse of Break Object)
- **Function node** — user-authored TypeScript transforms with typed inputs/outputs
- **Stop button** — abort running flow at next node boundary
- **Viewport persistence** — zoom/pan saved per flow with smooth animated transitions
- **Minimap** — toggle with M key
- **Update checker** — notifies when a new GitHub release is available
- **Three-layer header merge** — project defaults → environment overrides → node-level
- **Pre-flight validation** — Run button disabled with reason when flow has errors
- **Request metadata in inspector** — see resolved URL + all headers after a run

### Infrastructure
- **Tauri 2** + Rust backend with reqwest + rusqlite
- **React 19** + Vite 6 + React Flow v12
- **Monorepo** — Turbo + Bun workspaces (core, shared, desktop)
- **CI/CD** — GitHub Actions builds for macOS (ARM + Intel) + Linux (x64)
- **Automated releases** — `bun run release patch/minor/major` bumps all configs, commits, tags, pushes
- **Landing page** — static HTML, auto-deployed to GitHub Pages
- **64 unit tests** covering executor, templates, schema walker, auth injection
- **Rebranded** from ApiFlow to TwistedRest

## [0.1.0] — 2026-04-08

### Added
- Initial prototype with Electrobun (later migrated to Tauri)
- Basic canvas with Start and HTTP Request nodes
- SQLite persistence via bun:sqlite (later migrated to rusqlite)
