//! `twistedflow plugin` — scaffold and build WASM plugin crates.
//!
//! Commands:
//!   twistedflow plugin new <name> [--category C] [--description D] [--node N]... [--force]
//!   twistedflow plugin build [--project DIR] [--install DIR] [--no-install] [--debug]

use std::path::PathBuf;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum PluginCmd {
    /// Scaffold a new WASM plugin crate
    New {
        /// Plugin directory name (creates ./<name>/)
        name: String,
        /// Display category for the nodes (e.g. "Text", "Utility")
        #[arg(long, default_value = "Utility")]
        category: String,
        /// Short description
        #[arg(long, default_value = "")]
        description: String,
        /// Pre-declare a node. Repeatable: --node Foo --node Bar
        #[arg(long = "node")]
        nodes: Vec<String>,
        /// Overwrite if directory exists
        #[arg(long)]
        force: bool,
    },
    /// Compile the plugin in the current directory and install it
    Build {
        /// Project directory to install into (defaults to nearest parent with twistedflow.toml)
        #[arg(long)]
        project: Option<PathBuf>,
        /// Install path (overrides auto-detection)
        #[arg(long)]
        install: Option<PathBuf>,
        /// Skip install, leave .wasm in target/
        #[arg(long)]
        no_install: bool,
        /// Debug build (skip --release)
        #[arg(long)]
        debug: bool,
    },
}

pub fn run_new(
    name: &str,
    category: &str,
    description: &str,
    nodes: &[String],
    force: bool,
) -> Result<(), String> {
    let result =
        twistedflow_plugin_dev::scaffold_plugin(twistedflow_plugin_dev::ScaffoldPluginOptions {
            target_dir: PathBuf::from(name),
            plugin_name: name.to_string(),
            category: category.to_string(),
            description: description.to_string(),
            requested_nodes: nodes.to_vec(),
            force,
            readme_kind: twistedflow_plugin_dev::ReadmeKind::Cli,
        })?;

    println!("✓ Created {}/", result.source_dir.display());
    println!("  Next: cd {} && twistedflow plugin build", name);
    Ok(())
}

pub fn run_build(
    project: Option<PathBuf>,
    install: Option<PathBuf>,
    no_install: bool,
    debug: bool,
) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|e| format!("Failed to get CWD: {}", e))?;

    let install_dir = if no_install {
        None
    } else if let Some(dir) = install {
        Some(dir)
    } else {
        let project_dir = if let Some(project) = project {
            twistedflow_project::validate_project_dir(&project)?
        } else {
            twistedflow_project::find_project_root(&cwd).ok_or_else(|| {
                format!(
                    "Could not find a TwistedFlow project above {}. Run from inside <project>/nodes-src/<plugin>, pass --project /path/to/project, pass --install /path/to/nodes, or use --no-install.",
                    cwd.display()
                )
            })?
        };
        Some(project_dir.join("nodes"))
    };

    let result =
        twistedflow_plugin_dev::build_plugin(twistedflow_plugin_dev::BuildPluginOptions {
            source_dir: cwd,
            install_dir,
            debug,
        })?;

    println!(
        "✓ Valid plugin '{}' with {} node(s):",
        result.crate_name,
        result.nodes.len()
    );
    for node in &result.nodes {
        println!("    • {} ({})", node.name, node.type_id);
    }

    if let Some(installed_path) = result.installed_path {
        let size = std::fs::metadata(&installed_path)
            .map(|m| m.len() / 1024)
            .unwrap_or(0);
        println!("✓ Installed: {} ({} KB)", installed_path.display(), size);
    } else {
        println!("✓ Built: {}", result.wasm_path.display());
    }

    Ok(())
}
