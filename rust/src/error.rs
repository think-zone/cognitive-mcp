use thiserror::Error;

/// Crate-wide error type. Crypto failures are deliberately opaque (no detail
/// about *why* a decrypt failed) so they can't become an oracle.
#[derive(Debug, Error)]
pub enum Error {
    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("db error: {0}")]
    Db(String),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
