//! Crypto core: Argon2id key derivation, an envelope (KEK wraps DEK), and
//! authenticated encryption (XChaCha20-Poly1305) with AAD binding.
//!
//! Design choices (see private/SECURITY-ARCHITECTURE.md):
//! - XChaCha20-Poly1305: the 192-bit nonce makes random nonces safe forever,
//!   removing the nonce-reuse footgun that AES-GCM carries.
//! - Argon2id at OWASP-strong parameters for passphrase -> KEK.
//! - All key material is held in [`Key`], which zeroizes on drop.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::error::{Error, Result};

type HmacSha256 = Hmac<Sha256>;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;

// Argon2id parameters — OWASP-strong; ~0.25-0.4s on modern hardware. Unlock is
// paid once per open, so we can afford to be generous.
const ARGON_M_COST_KIB: u32 = 65536; // 64 MiB
const ARGON_T_COST: u32 = 3;
const ARGON_P_COST: u32 = 1;

const DEK_WRAP_AAD: &[u8] = b"cognitive-mcp:dek-wrap:v1";

/// A 256-bit symmetric key that zeroizes its bytes on drop.
#[derive(Clone)]
pub struct Key([u8; KEY_LEN]);

impl Key {
    pub fn from_bytes(b: [u8; KEY_LEN]) -> Self {
        Key(b)
    }

    /// Generate a fresh random key from the OS CSPRNG.
    pub fn random() -> Self {
        let mut b = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut b);
        Key(b)
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Derive a Key-Encryption-Key from a passphrase with Argon2id.
pub fn derive_kek(passphrase: &[u8], salt: &[u8]) -> Result<Key> {
    let params = Params::new(ARGON_M_COST_KIB, ARGON_T_COST, ARGON_P_COST, Some(KEY_LEN))
        .map_err(|e| Error::Crypto(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|e| Error::Crypto(format!("argon2 derive: {e}")))?;
    let key = Key(out);
    out.zeroize();
    Ok(key)
}

/// AEAD seal. Output layout: `nonce(24) || ciphertext || tag(16)`.
/// `aad` is authenticated but not encrypted — bind it to the storage context
/// (table/column/row) to defeat ciphertext relocation attacks.
pub fn seal(key: &Key, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
        .map_err(|_| Error::Crypto("invalid key length".into()))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| Error::Crypto("seal failed".into()))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// AEAD open. Input layout must be `nonce(24) || ciphertext || tag(16)`.
/// Returns an opaque error on any failure (wrong key, tampered data, wrong AAD).
pub fn open(key: &Key, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < NONCE_LEN {
        return Err(Error::Crypto("ciphertext too short".into()));
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
        .map_err(|_| Error::Crypto("invalid key length".into()))?;
    let nonce = XNonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, Payload { msg: ct, aad })
        .map_err(|_| Error::Crypto("open failed".into()))
}

/// Wrap a DEK under a KEK (envelope encryption).
pub fn wrap_dek(kek: &Key, dek: &Key) -> Result<Vec<u8>> {
    seal(kek, dek.as_bytes(), DEK_WRAP_AAD)
}

/// Unwrap a DEK previously wrapped with [`wrap_dek`].
pub fn unwrap_dek(kek: &Key, wrapped: &[u8]) -> Result<Key> {
    let mut bytes = open(kek, wrapped, DEK_WRAP_AAD)?;
    if bytes.len() != KEY_LEN {
        bytes.zeroize();
        return Err(Error::Crypto("unwrapped DEK has wrong length".into()));
    }
    let mut arr = [0u8; KEY_LEN];
    arr.copy_from_slice(&bytes);
    bytes.zeroize();
    let key = Key(arr);
    arr.zeroize();
    Ok(key)
}

/// A fresh 16-byte salt for [`derive_kek`].
pub fn random_salt() -> [u8; 16] {
    let mut s = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut s);
    s
}

/// Derive a labeled subkey from a master key via HMAC-SHA256, so a single master
/// DEK never gets reused directly across two cipher domains (e.g. full-DB AES vs
/// field-level XChaCha20). Different labels yield independent keys.
pub fn derive_subkey(master: &Key, label: &[u8]) -> Key {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(master.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(label);
    let tag = mac.finalize().into_bytes();
    let mut arr = [0u8; KEY_LEN];
    arr.copy_from_slice(&tag);
    let key = Key(arr);
    arr.zeroize();
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = Key::random();
        let aad = b"ctx:test";
        let blob = seal(&key, b"top secret", aad).unwrap();
        assert_ne!(&blob[NONCE_LEN..], b"top secret"); // ciphertext != plaintext
        let pt = open(&key, &blob, aad).unwrap();
        assert_eq!(pt, b"top secret");
    }

    #[test]
    fn wrong_aad_fails() {
        let key = Key::random();
        let blob = seal(&key, b"data", b"aad-A").unwrap();
        assert!(open(&key, &blob, b"aad-B").is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let k1 = Key::random();
        let k2 = Key::random();
        let blob = seal(&k1, b"data", b"x").unwrap();
        assert!(open(&k2, &blob, b"x").is_err());
    }

    #[test]
    fn tamper_is_detected() {
        let key = Key::random();
        let mut blob = seal(&key, b"data", b"x").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        assert!(open(&key, &blob, b"x").is_err());
    }

    #[test]
    fn envelope_wrap_unwrap() {
        let salt = random_salt();
        let kek = derive_kek(b"correct horse battery staple", &salt).unwrap();
        let dek = Key::random();
        let wrapped = wrap_dek(&kek, &dek).unwrap();
        let unwrapped = unwrap_dek(&kek, &wrapped).unwrap();
        assert_eq!(unwrapped.as_bytes(), dek.as_bytes());

        // wrong passphrase cannot unwrap
        let bad = derive_kek(b"wrong passphrase", &salt).unwrap();
        assert!(unwrap_dek(&bad, &wrapped).is_err());
    }

    #[test]
    fn subkeys_are_distinct_and_deterministic() {
        let master = Key::random();
        let a = derive_subkey(&master, b"db-encryption");
        let b = derive_subkey(&master, b"field-encryption");
        let a2 = derive_subkey(&master, b"db-encryption");
        assert_ne!(a.as_bytes(), b.as_bytes()); // different labels -> different keys
        assert_eq!(a.as_bytes(), a2.as_bytes()); // same label -> same key
        assert_ne!(a.as_bytes(), master.as_bytes()); // subkey != master
    }

    #[test]
    fn argon2_is_deterministic_for_same_inputs() {
        let salt = [7u8; 16];
        let a = derive_kek(b"pw", &salt).unwrap();
        let b = derive_kek(b"pw", &salt).unwrap();
        assert_eq!(a.as_bytes(), b.as_bytes());
        let c = derive_kek(b"pw", &[8u8; 16]).unwrap();
        assert_ne!(a.as_bytes(), c.as_bytes()); // different salt -> different key
    }
}
