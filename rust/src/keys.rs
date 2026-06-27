//! Interim key bootstrap (envelope encryption).
//!
//! A passphrase is stretched with Argon2id into a Key-Encryption-Key, which
//! wraps a random Data-Encryption-Key persisted (wrapped) in a sidecar next to
//! the database. Changing the passphrase only re-wraps the DEK — the database is
//! never re-encrypted. The blind-index pepper is supplied separately and must
//! live OUTSIDE the database directory.
//!
//! NOTE: this is the *interim* custody model. Real custody — OS keystore / TPM /
//! Secure Enclave for unattended mode, passphrase+hardware for attended mode —
//! is a later phase (see private/SECURITY-ARCHITECTURE.md §5). The on-disk DEK
//! wrap here is only as strong as the passphrase and the host's full-disk
//! encryption; it does not resist live same-user malware.

use std::fs;
use std::path::Path;

use crate::crypto::{self, Key};
use crate::error::{Error, Result};

fn read_or_create_salt(salt_path: &Path) -> Result<[u8; 16]> {
    if let Ok(b) = fs::read(salt_path) {
        if b.len() == 16 {
            let mut s = [0u8; 16];
            s.copy_from_slice(&b);
            return Ok(s);
        }
    }
    let s = crypto::random_salt();
    fs::write(salt_path, s).map_err(|e| Error::Db(format!("write salt: {e}")))?;
    Ok(s)
}

/// Load the DEK for `db_path`: derive the KEK from `passphrase` (Argon2id over a
/// persisted salt), then unwrap the stored DEK — or, on first run, mint a random
/// DEK and persist it wrapped.
pub fn load_or_init_dek(db_path: &str, passphrase: &[u8]) -> Result<Key> {
    let salt_path = format!("{db_path}.salt");
    let dek_path = format!("{db_path}.dek");
    let salt = read_or_create_salt(Path::new(&salt_path))?;
    let kek = crypto::derive_kek(passphrase, &salt)?;

    if let Ok(wrapped) = fs::read(&dek_path) {
        // Wrong passphrase -> unwrap fails (authenticated) rather than corrupting.
        return crypto::unwrap_dek(&kek, &wrapped);
    }
    let dek = Key::random();
    let wrapped = crypto::wrap_dek(&kek, &dek)?;
    fs::write(&dek_path, &wrapped).map_err(|e| Error::Db(format!("write dek: {e}")))?;
    Ok(dek)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn dek_is_stable_across_opens_and_rejects_wrong_passphrase() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("mem.db");
        let db = db.to_str().unwrap();

        let d1 = load_or_init_dek(db, b"correct passphrase").unwrap();
        let d2 = load_or_init_dek(db, b"correct passphrase").unwrap();
        assert_eq!(d1.as_bytes(), d2.as_bytes()); // same passphrase -> same DEK

        // wrong passphrase cannot unwrap the persisted DEK
        assert!(load_or_init_dek(db, b"wrong passphrase").is_err());
    }
}
