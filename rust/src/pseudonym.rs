//! Pseudonymization via keyed-HMAC blind indexes.
//!
//! The dangerous artifact — "identifier A and identifier B are the same person"
//! — is never stored in plaintext. Each identifier is mapped to a stable,
//! truncated, keyed HMAC ("blind index") that points at an opaque person id.
//! The HMAC pepper lives in a keystore the database never sees, so a DB-only
//! exfiltration cannot run a dictionary attack against low-entropy identifiers.
//!
//! See private/SECURITY-ARCHITECTURE.md §6.

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::error::{Error, Result};

type HmacSha256 = Hmac<Sha256>;

/// Separator byte between the namespace and the normalized identifier, so
/// `("ab", "c")` and `("a", "bc")` cannot collide.
const SEP: u8 = 0x1F;

/// Normalize an identifier for stable matching. Conservative: trim + lowercase.
///
/// NOTE: Unicode NFC normalization is a planned refinement (std lacks it);
/// changing normalization rules invalidates all existing blind indexes, so the
/// rules are effectively part of the key — version them before changing.
pub fn normalize(id: &str) -> String {
    id.trim().to_lowercase()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<[u8; 32]> {
    let mut mac =
        HmacSha256::new_from_slice(key).map_err(|e| Error::Crypto(format!("hmac key: {e}")))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().into())
}

/// Derive a per-namespace subkey from the root pepper. Cracking one namespace's
/// index reveals nothing about another, and identical values in different
/// namespaces produce different indexes.
pub fn namespace_key(root_pepper: &[u8], namespace: &str) -> Result<[u8; 32]> {
    let mut data = Vec::with_capacity(3 + namespace.len());
    data.extend_from_slice(b"ns:");
    data.extend_from_slice(namespace.as_bytes());
    hmac_sha256(root_pepper, &data)
}

/// Compute a truncated blind index for an identifier within a namespace.
///
/// `truncate_bytes` trades leakage against false positives: too long and equal
/// indexes prove equal plaintext (frequency leakage); too short and lookups
/// return many spurious rows. Pick it to satisfy `2 <= C < sqrt(R)` for your
/// row count `R` (see design doc). Clamped to `1..=32`.
pub fn blind_index(
    root_pepper: &[u8],
    namespace: &str,
    id: &str,
    truncate_bytes: usize,
) -> Result<Vec<u8>> {
    let nk = namespace_key(root_pepper, namespace)?;
    let norm = normalize(id);
    let mut data = Vec::with_capacity(namespace.len() + 1 + norm.len());
    data.extend_from_slice(namespace.as_bytes());
    data.push(SEP);
    data.extend_from_slice(norm.as_bytes());
    let full = hmac_sha256(&nk, &data)?;
    let n = truncate_bytes.clamp(1, full.len());
    Ok(full[..n].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEPPER: &[u8] = b"a-secret-pepper-held-in-the-keystore";

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize("  Alice@Example.COM "), "alice@example.com");
    }

    #[test]
    fn deterministic_for_same_input() {
        let a = blind_index(PEPPER, "email", "alice@example.com", 16).unwrap();
        let b = blind_index(PEPPER, "email", "ALICE@example.com ", 16).unwrap();
        assert_eq!(a, b); // normalization makes these match
    }

    #[test]
    fn differs_by_namespace() {
        let a = blind_index(PEPPER, "email", "same", 16).unwrap();
        let b = blind_index(PEPPER, "handle", "same", 16).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn differs_by_pepper() {
        let a = blind_index(PEPPER, "email", "x", 16).unwrap();
        let b = blind_index(b"different-pepper", "email", "x", 16).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn index_is_not_the_plaintext_and_is_truncated() {
        let bi = blind_index(PEPPER, "email", "alice@example.com", 16).unwrap();
        assert_eq!(bi.len(), 16);
        assert_ne!(bi.as_slice(), b"alice@example.com");
    }

    #[test]
    fn truncation_length_is_clamped() {
        assert_eq!(blind_index(PEPPER, "n", "v", 0).unwrap().len(), 1);
        assert_eq!(blind_index(PEPPER, "n", "v", 999).unwrap().len(), 32);
    }
}
