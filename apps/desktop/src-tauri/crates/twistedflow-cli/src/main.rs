//! TwistedFlow CLI — run and build flows.
//!
//! Usage:
//!   twistedflow run <flow.json>
//!   twistedflow build <flow.json or project dir> -o <binary>

mod build;

// Ensure twistedflow-nodes is linked so inventory discovers all built-in nodes.
extern crate twistedflow_nodes;

use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use twistedflow_engine::{
    FlowFile, GraphIndex, LogEntry, RunFlowOpts, StatusEvent,
    build_registry, load_wasm_plugins, DEFAULT_PLUGINS_DIR,
};

#[derive(Parser)]
#[command(name = "twistedflow", about = "TwistedFlow — visual flow engine CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run a .flow.json file headlessly
    Run {
        /// Path to the .flow.json file
        file: PathBuf,

        /// Plugin directories (comma-separated). Default: ~/.twistedflow/plugins
        #[arg(long, default_value = DEFAULT_PLUGINS_DIR)]
        plugins: String,

        /// Environment variables as key=value pairs
        #[arg(long = "env", short = 'e')]
        env_vars: Vec<String>,

        /// Base URL for HTTP requests
        #[arg(long)]
        base_url: Option<String>,

        /// Quiet mode — only print errors
        #[arg(long, short)]
        quiet: bool,
    },
    /// Compile a flow into a standalone binary
    Build {
        /// Project directory (must contain twistedflow.toml)
        project: PathBuf,

        /// Output binary path
        #[arg(short, long)]
        output: String,

        /// Flow to embed (name without .flow.json). Default: first found.
        #[arg(long)]
        flow: Option<String>,

        /// Environment to bake in (.env.NAME). Default: "default" (.env)
        #[arg(long, default_value = "default")]
        env: String,

        /// Debug build (faster compile, larger binary)
        #[arg(long)]
        debug: bool,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Run {
            file,
            plugins,
            env_vars,
            base_url,
            quiet,
        } => {
            let code = run_flow(file, plugins, env_vars, base_url, quiet).await;
            std::process::exit(code);
        }
        Commands::Build { project, output, flow, env, debug } => {
            if let Err(e) = build::build(&project, &output, flow.as_deref(), &env, !debug) {
                eprintln!("Build failed: {}", e);
                std::process::exit(1);
            }
        }
    }
}

async fn run_flow(
    file: PathBuf,
    plugins: String,
    env_vars: Vec<String>,
    base_url: Option<String>,
    quiet: bool,
) -> i32 {
    // 1. Read and parse the flow file
    let content = match std::fs::read_to_string(&file) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: cannot read {}: {}", file.display(), e);
            return 1;
        }
    };

    let flow_file = match FlowFile::parse(&content) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Error: {}", e);
            return 1;
        }
    };

    if !quiet {
        eprintln!("▶ Running flow: {}", flow_file.name);
    }

    // 2. Convert domain → engine graph
    let graph = flow_file.to_graph();
    let index = Arc::new(GraphIndex::build(&graph));

    // 3. Build node registry (built-in + WASM plugins)
    let mut registry = build_registry();

    let plugin_dirs: Vec<&str> = plugins.split(',').map(|s| s.trim()).collect();
    let wasm_nodes = load_wasm_plugins(&plugin_dirs);
    let wasm_count = wasm_nodes.len();
    for (type_id, node, _meta) in wasm_nodes {
        registry.insert(type_id, node);
    }

    if !quiet && wasm_count > 0 {
        eprintln!("  loaded {} WASM plugin node(s)", wasm_count);
    }

    // 4. Parse env vars
    let mut env_map: HashMap<String, serde_json::Value> = HashMap::new();
    for pair in &env_vars {
        if let Some((k, v)) = pair.split_once('=') {
            env_map.insert(k.to_string(), serde_json::Value::String(v.to_string()));
        }
    }

    // 5. Build execution context
    let context = twistedflow_engine::ExecContext {
        project_base_url: base_url,
        env_base_url: None,
        project_headers: None,
        env_headers: None,
        env_vars: if env_map.is_empty() { None } else { Some(env_map) },
        auth: None,
    };

    // 6. Set up status + log callbacks
    let quiet_status = quiet;
    let on_status: Box<dyn Fn(&str, StatusEvent) + Send + Sync> =
        Box::new(move |node_id: &str, event: StatusEvent| {
            if quiet_status && event.status != "error" {
                return;
            }
            match event.status.as_str() {
                "error" => {
                    eprintln!(
                        "  ✗ {} — {}",
                        node_id,
                        event.error.as_deref().unwrap_or("unknown error")
                    );
                }
                "ok" => {
                    if !quiet_status {
                        eprintln!("  ✓ {}", node_id);
                    }
                }
                _ => {}
            }
        });

    let quiet_log = quiet;
    let on_log: Box<dyn Fn(LogEntry) + Send + Sync> = Box::new(move |entry: LogEntry| {
        if quiet_log {
            return;
        }
        // Log entries go to stdout (they're the "output" of the flow)
        let value_str = match &entry.value {
            serde_json::Value::String(s) => s.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        };
        println!("[{}] {}", entry.label, value_str);
    });

    // 7. Build HTTP client
    let http_client = reqwest::Client::builder()
        .user_agent("TwistedFlow-CLI/0.1")
        .build()
        .expect("Failed to create HTTP client");

    let cancel = CancellationToken::new();

    // Handle Ctrl+C
    let cancel_clone = cancel.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        eprintln!("\n⏹ Interrupted");
        cancel_clone.cancel();
    });

    let opts = Arc::new(RunFlowOpts {
        index,
        context,
        on_status,
        on_log,
        cancel,
        http_client,
        registry,
    });

    // 8. Run!
    match twistedflow_engine::run_flow(opts).await {
        Ok(()) => {
            if !quiet {
                eprintln!("✓ Flow completed");
            }
            0
        }
        Err(e) => {
            eprintln!("✗ Flow failed: {}", e);
            1
        }
    }
}
