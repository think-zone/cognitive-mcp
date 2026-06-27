//! TPM-sealed key wrapping via CNG / NCrypt + the Microsoft Platform Crypto
//! Provider.
//!
//! Wraps a small secret (a 32-byte data key) with a **non-exportable**,
//! TPM-resident RSA-2048 key. The RSA private key is generated inside the TPM
//! and never leaves it, so the sealed blob on disk cannot be unwrapped on any
//! other machine, and the key itself cannot be exfiltrated for offline use.
//!
//! Windows-only. Per-user key (no admin required). Bound to this machine + user.

#![cfg(windows)]

use std::ffi::c_void;

use windows::core::{w, Result, PCWSTR};
use windows::Win32::Foundation::NTE_EXISTS;
use windows::Win32::Security::Cryptography::{
    NCryptCreatePersistedKey, NCryptDecrypt, NCryptEncrypt, NCryptFinalizeKey, NCryptFreeObject,
    NCryptOpenKey, NCryptOpenStorageProvider, NCryptSetProperty, BCRYPT_OAEP_PADDING_INFO,
    BCRYPT_RSA_ALGORITHM, BCRYPT_SHA256_ALGORITHM, CERT_KEY_SPEC, MS_PLATFORM_CRYPTO_PROVIDER,
    NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_FLAGS, NCRYPT_HANDLE, NCRYPT_KEY_HANDLE,
    NCRYPT_LENGTH_PROPERTY, NCRYPT_PAD_OAEP_FLAG, NCRYPT_PROV_HANDLE, NCRYPT_SILENT_FLAG,
};

/// Persisted name of our TPM-resident key-encryption key.
const KEY_NAME: PCWSTR = w!("cognitive-mcp-tpm-kek");

/// RSA modulus size in bits. 2048 is universally supported by TPM 2.0.
const RSA_BITS: u32 = 2048;

// RAII wrappers so handles are always freed, even on error paths.
struct Provider(NCRYPT_PROV_HANDLE);
impl Drop for Provider {
    fn drop(&mut self) {
        if self.0 .0 != 0 {
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.0 .0));
            }
        }
    }
}

struct Key(NCRYPT_KEY_HANDLE);
impl Drop for Key {
    fn drop(&mut self) {
        if self.0 .0 != 0 {
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.0 .0));
            }
        }
    }
}

fn open_provider() -> Result<Provider> {
    let mut h = NCRYPT_PROV_HANDLE::default();
    unsafe { NCryptOpenStorageProvider(&mut h, MS_PLATFORM_CRYPTO_PROVIDER, 0)? };
    Ok(Provider(h))
}

fn open_existing_key(prov: &Provider) -> Result<Key> {
    let mut h = NCRYPT_KEY_HANDLE::default();
    unsafe { NCryptOpenKey(prov.0, &mut h, KEY_NAME, CERT_KEY_SPEC(0), NCRYPT_SILENT_FLAG)? };
    Ok(Key(h))
}

/// Get the persisted TPM key: open it if it exists, otherwise create it ONCE.
/// Never overwrites — an existing key is never destroyed, so all sealed blobs
/// stay decryptable. On a creation race we fall back to opening.
fn get_key(prov: &Provider) -> Result<Key> {
    if let Ok(k) = open_existing_key(prov) {
        return Ok(k);
    }
    let mut h = NCRYPT_KEY_HANDLE::default();
    let create = unsafe {
        NCryptCreatePersistedKey(
            prov.0,
            &mut h,
            BCRYPT_RSA_ALGORITHM,
            KEY_NAME,
            CERT_KEY_SPEC(0),
            NCRYPT_FLAGS(0), // NOT overwrite — never clobber an existing key
        )
    };
    match create {
        Ok(()) => {
            let key = Key(h);
            // Properties MUST be set before finalize.
            let len_bytes = RSA_BITS.to_le_bytes();
            unsafe {
                NCryptSetProperty(
                    NCRYPT_HANDLE(key.0 .0),
                    NCRYPT_LENGTH_PROPERTY,
                    &len_bytes,
                    NCRYPT_SILENT_FLAG,
                )?
            };
            // Export policy 0 => private key is non-exportable.
            let export_policy: u32 = 0;
            unsafe {
                NCryptSetProperty(
                    NCRYPT_HANDLE(key.0 .0),
                    NCRYPT_EXPORT_POLICY_PROPERTY,
                    &export_policy.to_le_bytes(),
                    NCRYPT_SILENT_FLAG,
                )?
            };
            unsafe { NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG)? };
            Ok(key)
        }
        // Another process created it first — open that one.
        Err(e) if e.code() == NTE_EXISTS => open_existing_key(prov),
        Err(e) => Err(e),
    }
}

fn oaep_info() -> BCRYPT_OAEP_PADDING_INFO {
    BCRYPT_OAEP_PADDING_INFO {
        pszAlgId: BCRYPT_SHA256_ALGORITHM,
        pbLabel: std::ptr::null_mut(),
        cbLabel: 0,
    }
}

/// `true` if the Microsoft Platform Crypto Provider (TPM) is present and openable.
pub fn is_available() -> bool {
    open_provider().is_ok()
}

/// Wrap `plaintext` (<= 190 bytes) with the TPM key using OAEP-SHA256.
/// Creates the persisted TPM key on first use.
pub fn seal(plaintext: &[u8]) -> Result<Vec<u8>> {
    let prov = open_provider()?;
    let key = get_key(&prov)?;
    let pad = oaep_info();
    let pad_ptr: *const c_void = (&pad as *const BCRYPT_OAEP_PADDING_INFO).cast();

    let mut needed: u32 = 0;
    unsafe {
        NCryptEncrypt(
            key.0,
            Some(plaintext),
            Some(pad_ptr),
            None,
            &mut needed,
            NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG,
        )?
    };
    let mut out = vec![0u8; needed as usize];
    let mut written: u32 = 0;
    unsafe {
        NCryptEncrypt(
            key.0,
            Some(plaintext),
            Some(pad_ptr),
            Some(&mut out),
            &mut written,
            NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG,
        )?
    };
    out.truncate(written as usize);
    Ok(out)
}

/// Unwrap a blob produced by [`seal`] using the same TPM key.
pub fn unseal(ciphertext: &[u8]) -> Result<Vec<u8>> {
    let prov = open_provider()?;
    let key = open_existing_key(&prov)?;
    let pad = oaep_info();
    let pad_ptr: *const c_void = (&pad as *const BCRYPT_OAEP_PADDING_INFO).cast();

    let mut needed: u32 = 0;
    unsafe {
        NCryptDecrypt(
            key.0,
            Some(ciphertext),
            Some(pad_ptr),
            None,
            &mut needed,
            NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG,
        )?
    };
    let mut out = vec![0u8; needed as usize];
    let mut written: u32 = 0;
    unsafe {
        NCryptDecrypt(
            key.0,
            Some(ciphertext),
            Some(pad_ptr),
            Some(&mut out),
            &mut written,
            NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG,
        )?
    };
    out.truncate(written as usize);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_through_real_tpm() {
        if !is_available() {
            eprintln!("skipping: Platform Crypto Provider / TPM not available");
            return;
        }
        let secret = [0x42u8; 32];
        let sealed = seal(&secret).expect("seal");
        assert_ne!(sealed.as_slice(), &secret[..]);
        let opened = unseal(&sealed).expect("unseal");
        assert_eq!(opened, secret);
    }
}
