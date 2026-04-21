# TwistedFlow Custom Node Author Guide

Write custom nodes in Rust, compile to WebAssembly, and install them into a TwistedFlow project. They appear in the node palette alongside built-in nodes.

## Table of Contents

1. [What is a custom node?](#what-is-a-custom-node)
2. [Quick start](#quick-start)
3. [The `nodes!` macro](#the-nodes-macro)
4. [Pin types](#pin-types)
5. [Reading inputs](#reading-inputs)
6. [Writing outputs](#writing-outputs)
7. [Host callbacks](#host-callbacks)
8. [Error handling](#error-handling)
9. [ABI details](#abi-details)
10. [Desktop authoring](#desktop-authoring)
11. [Testing locally](#testing-locally)
12. [Install locations](#install-locations)
13. [Troubleshooting](#troubleshooting)

---

## What is a custom node?

A custom node is a `.wasm` file that exports two functions TwistedFlow calls at runtime: `tf_metadata()` (describes the nodes it provides) and `tf_execute()` (runs a single node with input values). The `twistedflow-plugin` crate hides the ABI behind a declarative `nodes!` macro — in practice, you only write the node logic.

Custom nodes run in a sandboxed [wasmtime](https://wasmtime.dev) instance with WASI preview 1. They can't access your host filesystem or network unless you explicitly import host callbacks (currently only `host::log`).

---

## Quick start

### Install the CLI

Download `twistedflow-cli` from [GitHub Releases](https://github.com/imkarmadev/TwistedFlow/releases). Each release includes `twistedflow-cli-<platform>.tar.gz` for macOS (ARM + Intel) and Linux (x64).

```bash
# macOS Apple Silicon example
tar -xzf twistedflow-cli-aarch64-apple-darwin.tar.gz
sudo mv twistedflow-cli /usr/local/bin/twistedflow
```

Or build from source: `cargo build --release -p twistedflow-cli` in `apps/desktop/src-tauri/`.

### Scaffold, build, run from CLI

```bash
# Scaffold — creates ./my-plugin/ with Cargo.toml, src/lib.rs, README
twistedflow plugin new my-plugin --category Utility --node Hello

cd my-plugin

# Edit src/lib.rs to implement your node

# Build + install — compiles to wasm32-wasip1, validates, copies into place
twistedflow plugin build
```

`twistedflow plugin build` installs into the nearest parent TwistedFlow project's `nodes/` directory by default.

## Desktop authoring

The desktop app exposes the same scaffold/build flow in the **Custom Nodes** tab:

1. Open a project
2. Open the **Custom Nodes** tab in the bottom workspace
3. Click **New Node**
4. Edit the generated Rust source in your editor
5. Click **Build Plugin** on that node tile

The desktop app writes source under `<project>/nodes-src/` and installs validated `.wasm` artifacts into `<project>/nodes/`.

---

## The `nodes!` macro

The macro declares one or more nodes and generates the WASM ABI for you.

```rust
use twistedflow_plugin::*;

nodes! {
    node "Uppercase" (
        type_id = "uppercase",
        category = "Text",
        description = "Convert a string to uppercase"
    ) {
        inputs: [{ key: "text", data_type: "string" }],
        outputs: [{ key: "result", data_type: "string" }],
        execute: |inputs| {
            let text = inputs.get_string("text").unwrap_or_default();
            PluginOutputs::new().set("result", text.to_uppercase())
        }
    }
}
```

### Fields

- **`name`** — Display name shown in the node palette and on the canvas node header.
- **`type_id`** — Unique identifier. Used in flow JSON files as `kind`. Must be unique across all plugins AND built-in nodes. Convention: `pluginCamelCase` to avoid collisions.
- **`category`** — Palette section (e.g. `"Text"`, `"JSON"`, `"Crypto"`). New categories appear automatically.
- **`description`** — Optional. One-line help text shown in the palette.
- **`inputs`** — Array of input pin definitions.
- **`outputs`** — Array of output pin definitions.
- **`execute`** — Closure `|PluginInputs| -> PluginOutputs`.

### Multi-node plugins

Declare as many nodes as you want in a single `nodes! { ... }` block. They all ship in one `.wasm` file:

```rust
nodes! {
    node "First"  (type_id = "first",  category = "Foo") { /* ... */ }
    node "Second" (type_id = "second", category = "Foo") { /* ... */ }
    node "Third"  (type_id = "third",  category = "Foo") { /* ... */ }
}
```

---

## Pin types

Declare each pin with a `key` (the pin name the user wires to) and `data_type`.

| `data_type` | Reads from | Canvas color |
|-------------|------------|--------------|
| `"string"`  | text       | pink         |
| `"number"`  | integer or float | green  |
| `"boolean"` | true/false | red          |
| `"object"`  | JSON object | blue        |
| `"array"`   | JSON array | purple       |
| `"unknown"` | anything   | grey         |
| `"null"`    | explicit null | grey      |

Unknown values at load time emit a warning but don't block the plugin. Wiring compatibility is enforced on the canvas — users can't drag a `number` source into a `string` input without going through a Convert node.

---

## Reading inputs

The closure receives a `PluginInputs` handle:

```rust
execute: |inputs| {
    // String (returns Option<String>)
    let name = inputs.get_string("name").unwrap_or_default();

    // Number (returns Option<f64>)
    let count = inputs.get_number("count").unwrap_or(0.0) as i64;

    // Boolean (returns Option<bool>)
    let enabled = inputs.get_bool("enabled").unwrap_or(false);

    // Object (returns Option<&Map<String, Value>>)
    if let Some(obj) = inputs.get_object("config") {
        let host = obj.get("host").and_then(|v| v.as_str()).unwrap_or("localhost");
    }

    // Array (returns Option<&Vec<Value>>)
    if let Some(arr) = inputs.get_array("items") {
        for item in arr { /* ... */ }
    }

    // Raw Value (always returns a Value, Null if missing)
    let anything = inputs.get_value("x");

    // Existence check
    if inputs.get("maybe").is_some() { /* ... */ }

    PluginOutputs::new()
}
```

If a pin isn't wired in the flow, its input is missing. Always handle the `None` / missing case explicitly — don't panic.

---

## Writing outputs

Use the `PluginOutputs` builder:

```rust
// Fluent chaining
PluginOutputs::new()
    .set("name", "Alice")           // &str → Value::String
    .set("age", 30)                 // i32 → Value::Number
    .set("verified", true)          // bool → Value::Bool
    .set("tags", vec!["a", "b"])    // Vec<&str> → Value::Array
```

For pre-built `Value`s (e.g. from parsing JSON):

```rust
let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
PluginOutputs::new().set_value("result", parsed)
```

Downstream nodes read these outputs via the pin keys you declared.

---

## Host callbacks

### `host::log(msg)`

Print a message to the TwistedFlow Console tab (desktop app) or stdout (CLI):

```rust
use twistedflow_plugin::*;

execute: |inputs| {
    let text = inputs.get_string("text").unwrap_or_default();
    host::log(&format!("processing {} chars", text.len()));
    PluginOutputs::new().set("result", text.to_uppercase())
}
```

Messages are tagged with the invoking node's id — same stream as the built-in Log node. Use this for trace output, debugging, or progress.

---

## Error handling

The plugin ABI currently has no `Result` type. Recommended patterns:

**Pattern 1: pass-through on failure** (common for transforms)

```rust
execute: |inputs| {
    let src = inputs.get_string("json").unwrap_or_default();
    match serde_json::from_str::<Value>(&src) {
        Ok(v) => PluginOutputs::new().set_value("result", v),
        Err(e) => {
            host::log(&format!("parse failed: {}", e));
            PluginOutputs::new().set("result", src) // unchanged
        }
    }
}
```

**Pattern 2: explicit error pin**

```rust
outputs: [
    { key: "result", data_type: "unknown" },
    { key: "error", data_type: "string" }
],
execute: |inputs| {
    match do_work(&inputs) {
        Ok(v) => PluginOutputs::new()
            .set_value("result", v)
            .set("error", ""),
        Err(e) => PluginOutputs::new()
            .set_value("result", Value::Null)
            .set("error", e.to_string()),
    }
}
```

Downstream nodes can branch on the `error` pin via If/Else.

---

## ABI details

For the curious. You don't need to understand this to write plugins.

**Exports:**
- `tf_metadata() -> *const u8` — returns pointer to `[u32 LE length][json bytes]`. JSON is `[{name, typeId, category, description, inputs, outputs}, ...]`.
- `tf_execute(type_id_ptr, type_id_len, inputs_ptr, inputs_len) -> *const u8` — same length-prefixed format for the return.

**Imports:**
- `env.tf_log(ptr: i32, len: i32)` — host reads UTF-8 from linear memory at `[ptr..ptr+len]`.

**Data exchange:** JSON via `serde_json`. All values cross the boundary as UTF-8 JSON strings written into WASM linear memory.

**Execution model:** synchronous. Plugins run on tokio's `spawn_blocking` pool. Keep per-call work short (< ~100ms) to avoid starving the pool.

---

## Testing locally

1. Build: `twistedflow plugin build`
2. Either:
   - Open the desktop app — the custom node appears in the palette for that project
   - Or run headless: `twistedflow-cli run some-flow.json` — custom node logs print to stdout

Custom nodes are loaded fresh on every flow run. In the desktop app, rebuilding from the **Custom Nodes** tab refreshes the palette for the active project.

---

## Install locations

TwistedFlow discovers custom nodes from one project-local directory:

| Path | Scope |
|------|-------|
| `<project>/nodes/` | Built/installed `.wasm` custom nodes for that project |

Editable source should live under `<project>/nodes-src/`. Built `.wasm`
artifacts live under `<project>/nodes/`.

`twistedflow plugin build` auto-picks the nearest parent directory containing
`twistedflow.toml` and installs into that project's `nodes/` directory.

To override: `twistedflow plugin build --project /path/to/project` or
`twistedflow plugin build --install /some/path`.

---

## Troubleshooting

**Custom node doesn't appear in palette**
- Check the target: must be `wasm32-wasip1` (NOT `wasm32-wasi`, the old name)
- Check the `.wasm` file exists in the active project's `nodes/` directory
- Look in the console/terminal for `[wasm-plugin] failed to load` warnings

**Missing required export 'tf_execute'**
- You forgot the `nodes! { ... }` macro, or removed it during edits

**Custom node logs not appearing**
- Make sure `host::log` is actually reached (add a log at the top of `execute`)
- In desktop, open the **Console** tab or toggle it with backtick (`` ` ``)
- In CLI, logs print to stdout with the `[plugin]` label

**Pin data_type warning on load**
- You typed an invalid value like `"strng"` — valid set: `string, number, boolean, object, array, unknown, null`

**Node runs but outputs are empty**
- Your `execute` closure probably returned `PluginOutputs::new()` without calling `.set(...)`
- Or you used a different pin key than declared in the `outputs` array

**`twistedflow plugin build` fails with "no target `wasm32-wasip1`"**
- Install the target: `rustup target add wasm32-wasip1`

---

## See also

- [`examples/plugins/text-utils/`](../examples/plugins/text-utils) — minimal reference
- [`examples/plugins/json-tools/`](../examples/plugins/json-tools) — multi-node, logging, object handling
