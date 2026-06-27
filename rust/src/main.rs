//! cognitive-mcp server — stdio MCP transport over the encrypted store.
//!
//! Exposes the SCOPED MEMORY tools only. The identity/person layer
//! (pseudonymized cross-platform resolution) is built and tested in the library
//! but is deliberately NOT exposed over MCP yet — it must not be callable until
//! the Tier-0 legal gate (lawful basis + platform ToS) clears.
//!
//! Keys are read from the environment (interim custody — see keys.rs):
//!   COGNITIVE_MCP_PASSPHRASE  required — stretched with Argon2id into the KEK
//!   COGNITIVE_MCP_PEPPER      required (>=16 chars) — blind-index pepper
//!   COGNITIVE_MCP_DB_PATH     optional — defaults to ~/.cognitive-mcp/memory.db

use std::sync::Arc;

use anyhow::Result;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData as McpError, ServerHandler, ServiceExt,
};
use tracing_subscriber::EnvFilter;

use cognitive_mcp::{custody, Store};

const DEFAULT_LIMIT: i64 = 20;

#[derive(Clone)]
struct CognitiveServer {
    store: Arc<Store>,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StoreReq {
    #[schemars(description = "The text to remember (1-10000 chars)")]
    content: String,
    #[serde(default)]
    #[schemars(description = "Optional labels to categorize this memory")]
    tags: Vec<String>,
    #[schemars(description = "Optional scope namespace (e.g. 'agent:cb'); defaults to 'agent:default'")]
    scope: Option<String>,
    #[schemars(description = "Optional time-to-live in seconds; the memory auto-expires and is purged after this many seconds")]
    ttl_seconds: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SearchReq {
    #[schemars(description = "Keywords; every whitespace-separated term must appear in content")]
    query: String,
    #[schemars(description = "Only search within these scopes; omit to search all")]
    scopes: Option<Vec<String>>,
    #[schemars(description = "Max results (default 20)")]
    limit: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListReq {
    #[schemars(description = "Only list these scopes; omit to list all")]
    scopes: Option<Vec<String>>,
    #[schemars(description = "Max results (default 20)")]
    limit: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ForgetReq {
    #[schemars(description = "The id of the memory to delete")]
    id: i64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PurgeReq {
    #[schemars(description = "The scope namespace to empty (deletes every memory in it)")]
    scope: String,
}

fn internal(e: impl std::fmt::Display) -> McpError {
    McpError::internal_error(e.to_string(), None)
}

fn render(memories: &[cognitive_mcp::Memory]) -> String {
    if memories.is_empty() {
        return "No memories found.".to_string();
    }
    let mut out = format!("{} mem(s):\n", memories.len());
    for m in memories {
        let tags = if m.tags.is_empty() {
            String::new()
        } else {
            format!(" [tags: {}]", m.tags.join(", "))
        };
        let scope = if m.scope == cognitive_mcp::DEFAULT_SCOPE {
            String::new()
        } else {
            format!(" ({})", m.scope)
        };
        out.push_str(&format!("#{}{} {}{}\n", m.id, scope, m.content, tags));
    }
    out
}

#[tool_router]
impl CognitiveServer {
    fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "Save a fact, note, or preference so it can be recalled in a later session. Optional tags and scope namespace.")]
    async fn memory_store(&self, Parameters(r): Parameters<StoreReq>) -> Result<String, McpError> {
        let m = self
            .store
            .store_memory(&r.content, &r.tags, r.scope.as_deref(), r.ttl_seconds)
            .await
            .map_err(internal)?;
        let ttl = m
            .expires_at
            .map(|_| format!(" (expires in {}s)", r.ttl_seconds.unwrap_or(0)))
            .unwrap_or_default();
        Ok(format!("Stored memory #{} in {}{}.", m.id, m.scope, ttl))
    }

    #[tool(description = "Keyword search across stored memories (case-insensitive, all terms must match). Optionally restrict to scopes.")]
    async fn memory_search(&self, Parameters(r): Parameters<SearchReq>) -> Result<String, McpError> {
        let scopes = r.scopes.unwrap_or_default();
        let page = self
            .store
            .search(&r.query, &scopes, r.limit.unwrap_or(DEFAULT_LIMIT))
            .await
            .map_err(internal)?;
        Ok(render(&page))
    }

    #[tool(description = "Browse stored memories, newest first. Optionally restrict to scopes.")]
    async fn memory_list(&self, Parameters(r): Parameters<ListReq>) -> Result<String, McpError> {
        let scopes = r.scopes.unwrap_or_default();
        let page = self
            .store
            .list(&scopes, r.limit.unwrap_or(DEFAULT_LIMIT))
            .await
            .map_err(internal)?;
        Ok(render(&page))
    }

    #[tool(description = "Permanently delete a single memory by its numeric id.")]
    async fn memory_forget(&self, Parameters(r): Parameters<ForgetReq>) -> Result<String, McpError> {
        let deleted = self.store.forget(r.id).await.map_err(internal)?;
        Ok(if deleted {
            format!("Deleted memory #{}.", r.id)
        } else {
            format!("No memory found with id {}; nothing deleted.", r.id)
        })
    }

    #[tool(description = "Permanently delete EVERY memory in a scope (namespace-level forget).")]
    async fn memory_purge(&self, Parameters(r): Parameters<PurgeReq>) -> Result<String, McpError> {
        let n = self.store.purge_scope(&r.scope).await.map_err(internal)?;
        Ok(format!("Purged {} memor(ies) from scope {}.", n, r.scope))
    }
}

#[tool_handler]
impl ServerHandler for CognitiveServer {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo / Implementation are #[non_exhaustive]; build from default
        // and set fields rather than using a struct literal.
        let mut info = ServerInfo::default();
        info.instructions = Some(
            "Encrypted, local-first persistent memory for AI agents. Scoped memory tools: \
             memory_store, memory_search, memory_list, memory_forget, memory_purge."
                .to_string(),
        );
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info.name = "cognitive-mcp".to_string();
        info.server_info.version = env!("CARGO_PKG_VERSION").to_string();
        info
    }
}

fn default_db_path() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{home}/.cognitive-mcp/memory.db")
}

#[tokio::main]
async fn main() -> Result<()> {
    // stdout is the JSON-RPC channel — all logging MUST go to stderr.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let db_path = std::env::var("COGNITIVE_MCP_DB_PATH").unwrap_or_else(|_| default_db_path());
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let (dek, pepper) = custody::resolve_keys(&db_path)?;
    let store = Store::open(&db_path, dek, pepper).await?;

    tracing::info!(
        "cognitive-mcp v{} ready (db: {db_path}, key custody: {})",
        env!("CARGO_PKG_VERSION"),
        custody::active_mode()
    );

    let service = CognitiveServer::new(Arc::new(store))
        .serve(stdio())
        .await
        .inspect_err(|e| tracing::error!("serve error: {e:?}"))?;
    service.waiting().await?;
    Ok(())
}
