# TwistedFlow Custom Node Examples

Reference implementations of TwistedFlow WASM custom nodes. Copy one, or use them as a template for your own.

| Example | What it teaches |
|---------|----------------|
| [`text-utils`](./text-utils) | Minimal reference — 4 string-transform nodes, single input/output each |
| [`json-tools`](./json-tools) | Multi-input/output, object handling, `host::log` callbacks, error paths |

## Build

From inside any example directory:

```bash
twistedflow plugin build
```

This compiles to `wasm32-wasip1` with release optimizations. Run it from inside `<project>/nodes-src/<plugin>` or pass `--project /path/to/project` to install the built `.wasm` into that project's `nodes/` directory.

## Write your own

```bash
twistedflow plugin new my-plugin --category Utility --node Foo --node Bar
cd my-plugin
# edit src/lib.rs
twistedflow plugin build
```

See the [plugin author guide](../../docs/plugins.md) for the full API reference.
