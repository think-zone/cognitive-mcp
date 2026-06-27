//! cognitive-mcp (Rust) — persistent, local-first, **encrypted** memory for AI
//! agents over the Model Context Protocol.
//!
//! Security model (full design in private/SECURITY-ARCHITECTURE.md):
//! - **Encryption at rest**: the whole database is encrypted (libsql AES-256,
//!   wired in the storage step); the most dangerous fields are *additionally*
//!   sealed with XChaCha20-Poly1305 ([`crypto`]).
//! - **No plaintext linkage**: cross-platform identities resolve to an opaque
//!   person id only through truncated keyed-HMAC blind indexes ([`pseudonym`]),
//!   with the pepper held outside the database.
//! - **Secret hygiene**: key material lives in types that zeroize on drop.

pub mod crypto;
pub mod custody;
pub mod error;
pub mod keys;
pub mod pseudonym;
pub mod store;
#[cfg(windows)]
pub mod tpm;

pub use error::{Error, Result};
pub use store::{Memory, Store, DEFAULT_SCOPE};
