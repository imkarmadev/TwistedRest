# json-tools

Example TwistedFlow WASM custom node pack demonstrating:
- Multi-node plugin (3 nodes in one `.wasm`)
- Object/array handling with `serde_json::Value`
- Multi-input, multi-output nodes
- Host callbacks via `host::log`
- Error paths (invalid JSON, missing path)

## Nodes

| Node | Inputs | Outputs | Description |
|------|--------|---------|-------------|
| **JSON Pretty** | `json: string` | `result: string` | Format JSON with 2-space indent |
| **JSON Minify** | `json: string` | `result: string` | Compact JSON to single line |
| **JSON Path** | `json: string`, `path: string` | `result: unknown`, `found: boolean` | Extract value at dot-path (`foo.bar.0.baz`) |

All three call `host::log` with trace info — messages appear in the desktop app's **Console** tab.

## Build & install

```bash
twistedflow plugin build
```

Or manually:

```bash
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/twistedflow_plugin_json_tools.wasm /path/to/project/nodes/
```

## Usage

In the desktop app, the three nodes appear under the "JSON" category in the palette. Drag them to the canvas, wire a string source (for example an HTTP Request body) into `json`, and feed the outputs into downstream nodes.
