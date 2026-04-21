//! Flow graph model and adjacency index.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type", default)]
    pub node_type: Option<String>,
    #[serde(default = "default_data")]
    pub data: serde_json::Value,
}

fn default_data() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    #[serde(default)]
    pub source_handle: Option<String>,
    pub target: String,
    #[serde(default)]
    pub target_handle: Option<String>,
    #[serde(default)]
    pub data: Option<EdgeData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeData {
    #[serde(default)]
    pub kind: Option<EdgeKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Exec,
    Data,
}

/// Pre-built adjacency index for O(1) edge lookups.
pub struct GraphIndex {
    pub nodes: HashMap<String, GraphNode>,
    /// Exec edges: (source_id, source_handle) → target_id
    pub exec_edges: HashMap<(String, String), String>,
    /// Data edges into a target: (target_id, target_handle) → (source_id, source_handle)
    pub data_edges_in: HashMap<(String, String), (String, String)>,
}

impl GraphIndex {
    pub fn build(graph: &FlowGraph) -> Self {
        let mut nodes = HashMap::with_capacity(graph.nodes.len());
        for node in &graph.nodes {
            nodes.insert(node.id.clone(), node.clone());
        }

        let mut exec_edges = HashMap::new();
        let mut data_edges_in = HashMap::new();

        for edge in &graph.edges {
            let kind = edge.data.as_ref().and_then(|d| d.kind);
            match kind {
                Some(EdgeKind::Exec) => {
                    let src_handle = edge.source_handle.clone().unwrap_or_default();
                    exec_edges.insert((edge.source.clone(), src_handle), edge.target.clone());
                }
                Some(EdgeKind::Data) => {
                    let tgt_handle = edge.target_handle.clone().unwrap_or_default();
                    let src_handle = edge.source_handle.clone().unwrap_or_default();
                    data_edges_in.insert(
                        (edge.target.clone(), tgt_handle),
                        (edge.source.clone(), src_handle),
                    );
                }
                None => {
                    // Legacy edges without explicit kind — treat as exec if handle looks exec-like
                    let src_handle = edge.source_handle.clone().unwrap_or_default();
                    if src_handle.starts_with("exec") || src_handle.is_empty() {
                        exec_edges.insert((edge.source.clone(), src_handle), edge.target.clone());
                    }
                }
            }
        }

        Self {
            nodes,
            exec_edges,
            data_edges_in,
        }
    }

    /// Find the next node along an exec edge from (source_id, handle).
    pub fn next_exec(&self, source_id: &str, handle: &str) -> Option<&str> {
        self.exec_edges
            .get(&(source_id.to_owned(), handle.to_owned()))
            .map(|s| s.as_str())
            // Tolerate unset handles for legacy edges
            .or_else(|| {
                if handle == "exec-out" {
                    self.exec_edges
                        .get(&(source_id.to_owned(), String::new()))
                        .map(|s| s.as_str())
                } else {
                    None
                }
            })
    }

    /// Find the data source connected to (target_id, target_handle).
    pub fn data_source(&self, target_id: &str, target_handle: &str) -> Option<(&str, &str)> {
        self.data_edges_in
            .get(&(target_id.to_owned(), target_handle.to_owned()))
            .map(|(s, h)| (s.as_str(), h.as_str()))
    }

    /// Find ALL data edges targeting a given node.
    pub fn data_edges_for(&self, target_id: &str) -> Vec<(&str, &str, &str)> {
        self.data_edges_in
            .iter()
            .filter(|((tid, _), _)| tid == target_id)
            .map(|((_, th), (si, sh))| (th.as_str(), si.as_str(), sh.as_str()))
            .collect()
    }

    pub fn get_node(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.get(id)
    }
}
