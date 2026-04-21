//! TwistedFlow CLI — run and build flows.
//!
//! Usage:
//!   twistedflow run <flow.json>
//!   twistedflow build <flow.json or project dir> -o <binary>

mod build;
mod plugin;

// Ensure twistedflow-nodes is linked so inventory discovers all built-in nodes.
extern crate twistedflow_nodes;

use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use twistedflow_engine::{FlowFile, GraphIndex, LogEntry, RunFlowOpts, StatusEvent};

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

        /// Extra plugin directories (comma-separated). Project nodes/ is loaded automatically.
        #[arg(long)]
        plugins: Option<String>,

        /// Environment variables as key=value pairs
        #[arg(long = "env", short = 'e')]
        env_vars: Vec<String>,

        /// Base URL for HTTP requests
        #[arg(long)]
        base_url: Option<String>,

        /// Quiet mode — only print errors
        #[arg(long, short)]
        quiet: bool,

        /// Extra arguments passed through to the flow (accessible via ParseArgs node)
        #[arg(last = true)]
        flow_args: Vec<String>,
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
    /// WASM plugin authoring commands
    Plugin {
        #[command(subcommand)]
        cmd: plugin::PluginCmd,
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
            flow_args: _, // flow_args are available via std::env::args() for ParseArgs node
        } => {
            let code = run_flow(file, plugins, env_vars, base_url, quiet).await;
            std::process::exit(code);
        }
        Commands::Build {
            project,
            output,
            flow,
            env,
            debug,
        } => {
            if let Err(e) = build::build(&project, &output, flow.as_deref(), &env, !debug) {
                eprintln!("Build failed: {}", e);
                std::process::exit(1);
            }
        }
        Commands::Plugin { cmd } => {
            let result = match cmd {
                plugin::PluginCmd::New {
                    name,
                    category,
                    description,
                    nodes,
                    force,
                } => plugin::run_new(&name, &category, &description, &nodes, force),
                plugin::PluginCmd::Build {
                    project,
                    install,
                    no_install,
                    debug,
                } => plugin::run_build(project, install, no_install, debug),
            };
            if let Err(e) = result {
                eprintln!("Error: {}", e);
                std::process::exit(1);
            }
        }
    }
}

async fn run_flow(
    file: PathBuf,
    plugins: Option<String>,
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

    // 3. Build node registry (built-in + project-local WASM nodes + subflows)
    let project_dir = twistedflow_project::find_project_root(
        file.parent().unwrap_or_else(|| std::path::Path::new(".")),
    );
    let extra_plugin_dirs = plugins
        .map(|extra_plugins| {
            extra_plugins
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let (registry, load) = twistedflow_project::build_runtime_registry(
        project_dir.as_deref(),
        &extra_plugin_dirs,
        |msg| eprintln!("{}", msg),
    );

    if !quiet && load.wasm_count > 0 {
        eprintln!("  loaded {} WASM plugin node(s)", load.wasm_count);
    }
    if !quiet && load.subflow_count > 0 {
        eprintln!("  loaded {} subflow(s)", load.subflow_count);
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
        env_vars: if env_map.is_empty() {
            None
        } else {
            Some(env_map)
        },
        auth: None,
        variables: None,
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
    let on_log: Arc<dyn Fn(LogEntry) + Send + Sync> = Arc::new(move |entry: LogEntry| {
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
        registry: std::sync::Arc::new(registry),
        processes: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
        depth: 0,
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
