//! Key custody — where the encryption keys actually come from.
//!
//! Selected by `COGNITIVE_MCP_KEY_MODE`:
//!
//! - **`keystore`** (default): the DEK and the blind-index pepper live in the OS
//!   keychain (Windows Credential Manager / macOS Keychain), protected by
//!   DPAPI/Keychain and bound to the logged-in user. **No secret is ever stored
//!   in a config file.** This is the unattended default — it defeats device
//!   theft and key exfiltration, but not live same-user malware (see
//!   private/SECURITY-ARCHITECTURE.md §5).
//!
//! - **`passphrase`**: attended / portable mode. The DEK is unwrapped from an
//!   Argon2id KEK derived from `COGNITIVE_MCP_PASSPHRASE`; the pepper comes from
//!   `COGNITIVE_MCP_PEPPER`.
//!
//! TPM 2.0 / Secure-Enclave non-exportable sealing is a future hardening that
//! can wrap the keystore item; the keystore here is the DPAPI-backed baseline
//! the research recommends as the unattended default.

use zeroize::Zeroize;

use crate::crypto::Key;
use crate::error::{Error, Result};
use crate::keys;

const KEYRING_SERVICE: &str = "cognitive-mcp";
const DEK_ENTRY: &str = "dek";
const PEPPER_ENTRY: &str = "pepper";

/// Resolve `(dek, pepper)` according to the configured custody mode.
pub fn resolve_keys(db_path: &str) -> Result<(Key, Vec<u8>)> {
    match std::env::var("COGNITIVE_MCP_KEY_MODE").ok().as_deref() {
        None | Some("keystore") => keystore_mode(),
        Some("tpm") => tpm_mode(db_path),
        Some("passphrase") => passphrase_mode(db_path),
        Some(other) => Err(Error::Crypto(format!(
            "unknown COGNITIVE_MCP_KEY_MODE '{other}' (use 'keystore', 'tpm', or 'passphrase')"
        ))),
    }
}

/// A short description of the active mode, for startup logging.
pub fn active_mode() -> &'static str {
    match std::env::var("COGNITIVE_MCP_KEY_MODE").ok().as_deref() {
        Some("passphrase") => "passphrase (attended)",
        Some("tpm") => "tpm (hardware-sealed)",
        _ => "keystore (OS keychain)",
    }
}

#[cfg(windows)]
fn keystore_mode() -> Result<(Key, Vec<u8>)> {
    let dek = load_or_create_keystore_key(DEK_ENTRY)?;
    let pepper = load_or_create_keystore_key(PEPPER_ENTRY)?;
    Ok((dek, pepper.as_bytes().to_vec()))
}

#[cfg(not(windows))]
fn keystore_mode() -> Result<(Key, Vec<u8>)> {
    Err(Error::Crypto(
        "keystore mode is only wired for Windows in this build; \
         set COGNITIVE_MCP_KEY_MODE=passphrase"
            .into(),
    ))
}

/// Read a 256-bit key from the OS keychain, creating + storing a fresh random
/// one on first use. The key is held in the keychain as hex.
#[cfg(windows)]
fn load_or_create_keystore_key(entry_name: &str) -> Result<Key> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)
        .map_err(|e| Error::Crypto(format!("keyring open ({entry_name}): {e}")))?;

    match entry.get_password() {
        Ok(mut hexkey) => {
            let bytes = hex::decode(hexkey.trim())
                .map_err(|_| Error::Crypto("keystore key is not valid hex".into()))?;
            hexkey.zeroize();
            if bytes.len() != 32 {
                return Err(Error::Crypto("keystore key has wrong length".into()));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            let mut bytes = bytes;
            bytes.zeroize();
            let key = Key::from_bytes(arr);
            arr.zeroize();
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            let key = Key::random();
            let mut hexkey = hex::encode(key.as_bytes());
            entry
                .set_password(&hexkey)
                .map_err(|e| Error::Crypto(format!("keyring store ({entry_name}): {e}")))?;
            hexkey.zeroize();
            Ok(key)
        }
        Err(e) => Err(Error::Crypto(format!("keyring read ({entry_name}): {e}"))),
    }
}

// --- TPM-sealed mode -------------------------------------------------------
// The DEK and pepper are sealed by a non-exportable TPM key and stored as
// sidecar blobs next to the database. The blobs are useless without this
// machine's TPM, and the wrapping key cannot be exfiltrated for offline use.

#[cfg(windows)]
fn tpm_mode(db_path: &str) -> Result<(Key, Vec<u8>)> {
    if !crate::tpm::is_available() {
        return Err(Error::Crypto(
            "TPM / Platform Crypto Provider not available; use COGNITIVE_MCP_KEY_MODE=keystore or passphrase".into(),
        ));
    }
    let dek = load_or_seal_key(&format!("{db_path}.dek.tpm"))?;
    let pepper = load_or_seal_key(&format!("{db_path}.pepper.tpm"))?;
    Ok((dek, pepper.as_bytes().to_vec()))
}

#[cfg(windows)]
fn load_or_seal_key(path: &str) -> Result<Key> {
    use std::fs;
    if let Ok(sealed) = fs::read(path) {
        let mut pt = crate::tpm::unseal(&sealed).map_err(|e| Error::Crypto(format!("tpm unseal: {e}")))?;
        if pt.len() != 32 {
            pt.zeroize();
            return Err(Error::Crypto("tpm-sealed key has wrong length".into()));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&pt);
        pt.zeroize();
        let key = Key::from_bytes(arr);
        arr.zeroize();
        Ok(key)
    } else {
        let key = Key::random();
        let sealed =
            crate::tpm::seal(key.as_bytes()).map_err(|e| Error::Crypto(format!("tpm seal: {e}")))?;
        fs::write(path, &sealed).map_err(|e| Error::Db(format!("write sealed key: {e}")))?;
        Ok(key)
    }
}

#[cfg(not(windows))]
fn tpm_mode(_db_path: &str) -> Result<(Key, Vec<u8>)> {
    Err(Error::Crypto(
        "TPM mode is Windows-only in this build; use COGNITIVE_MCP_KEY_MODE=keystore or passphrase".into(),
    ))
}

fn passphrase_mode(db_path: &str) -> Result<(Key, Vec<u8>)> {
    let passphrase = std::env::var("COGNITIVE_MCP_PASSPHRASE").map_err(|_| {
        Error::Crypto("COGNITIVE_MCP_PASSPHRASE is required in passphrase mode".into())
    })?;
    let pepper = std::env::var("COGNITIVE_MCP_PEPPER")
        .map_err(|_| Error::Crypto("COGNITIVE_MCP_PEPPER is required in passphrase mode".into()))?;
    if pepper.len() < 16 {
        return Err(Error::Crypto(
            "COGNITIVE_MCP_PEPPER must be at least 16 characters".into(),
        ));
    }
    let dek = keys::load_or_init_dek(db_path, passphrase.as_bytes())?;
    Ok((dek, pepper.into_bytes()))
}
