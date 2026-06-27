//! Encrypted memory store.
//!
//! Two layers of protection:
//! 1. **Full-database encryption** — the libsql file is AES-256 encrypted with a
//!    key derived from the master DEK. Search works because the DB is decrypted
//!    in memory once open.
//! 2. **Field-level encryption** of the catastrophic data — identifier values
//!    and person attributes are *additionally* sealed with XChaCha20-Poly1305,
//!    and cross-platform identities resolve to an opaque person id only through
//!    truncated keyed-HMAC blind indexes (no plaintext linkage on disk).
//!
//! See private/SECURITY-ARCHITECTURE.md §4-§6.

use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use libsql::{params_from_iter, Builder, Cipher, Connection, Database, EncryptionConfig, Value};
use uuid::Uuid;

use crate::crypto::{self, Key};
use crate::error::{Error, Result};
use crate::pseudonym;

pub const DEFAULT_SCOPE: &str = "agent:default";

/// Truncated blind-index length in bytes. Tune to satisfy `2 <= C < sqrt(R)`
/// for the expected row count (see design doc §6); 16 bytes is a safe default
/// well below the full 32-byte HMAC that would fingerprint the plaintext.
const BLIND_INDEX_BYTES: usize = 16;

fn db_err(e: libsql::Error) -> Error {
    Error::Db(e.to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A stored memory (the agent-facing, scoped note layer).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Memory {
    pub id: i64,
    pub content: String,
    pub tags: Vec<String>,
    pub scope: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT 'agent:default',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)",
    "CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)",
    "CREATE TABLE IF NOT EXISTS person (
        person_id BLOB PRIMARY KEY,
        created_at INTEGER NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1
    )",
    "CREATE TABLE IF NOT EXISTS person_identifier (
        blind_index BLOB NOT NULL,
        namespace TEXT NOT NULL,
        person_id BLOB NOT NULL REFERENCES person(person_id),
        enc_identifier BLOB,
        key_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blind_index, namespace)
    )",
    "CREATE INDEX IF NOT EXISTS idx_pid_person ON person_identifier(person_id)",
    "CREATE TABLE IF NOT EXISTS person_attribute (
        attr_id BLOB PRIMARY KEY,
        person_id BLOB NOT NULL REFERENCES person(person_id),
        attr_type TEXT NOT NULL,
        enc_value BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
    )",
    "CREATE INDEX IF NOT EXISTS idx_attr_person ON person_attribute(person_id)",
];

/// The encrypted store. Holds the libsql connection plus the field-encryption
/// key and the blind-index pepper. The master DEK is consumed at open and not
/// retained — only its derived subkeys live on (and zeroize on drop).
pub struct Store {
    _db: Database,
    conn: Connection,
    field_key: Key,
    pepper: Vec<u8>,
}

impl Store {
    /// Open (or create) an encrypted store at `path`.
    ///
    /// `dek` is the master data key (full-DB and field keys are derived from it
    /// via labeled HMAC). `pepper` keys the blind indexes and, per the design,
    /// should come from a keystore the database never sees.
    pub async fn open(path: &str, dek: Key, pepper: Vec<u8>) -> Result<Self> {
        let db_key = crypto::derive_subkey(&dek, b"db-encryption");
        let field_key = crypto::derive_subkey(&dek, b"field-encryption");
        // `dek` drops (and zeroizes) at the end of this function.

        let enc = EncryptionConfig::new(
            Cipher::Aes256Cbc,
            Bytes::copy_from_slice(db_key.as_bytes()),
        );
        let db = Builder::new_local(path)
            .encryption_config(enc)
            .build()
            .await
            .map_err(db_err)?;
        let conn = db.connect().map_err(db_err)?;

        let store = Store {
            _db: db,
            conn,
            field_key,
            pepper,
        };
        store.init().await?;
        Ok(store)
    }

    async fn init(&self) -> Result<()> {
        for stmt in SCHEMA {
            self.conn.execute(stmt, ()).await.map_err(db_err)?;
        }
        Ok(())
    }

    // --- memories (scope contract) ------------------------------------------

    pub async fn store_memory(
        &self,
        content: &str,
        tags: &[String],
        scope: Option<&str>,
    ) -> Result<Memory> {
        let scope = normalize_scope(scope);
        let tags = normalize_tags(tags);
        let tags_json = serde_json::to_string(&tags)?;
        let now = now_millis();
        self.conn
            .execute(
                "INSERT INTO memories (content, tags, scope, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params_from_iter([
                    Value::Text(content.to_string()),
                    Value::Text(tags_json),
                    Value::Text(scope.clone()),
                    Value::Integer(now),
                    Value::Integer(now),
                ]),
            )
            .await
            .map_err(db_err)?;
        Ok(Memory {
            id: self.conn.last_insert_rowid(),
            content: content.to_string(),
            tags,
            scope,
            created_at: now,
            updated_at: now,
        })
    }

    /// Browse newest-first, optionally restricted to one or more scopes.
    pub async fn list(&self, scopes: &[String], limit: i64) -> Result<Vec<Memory>> {
        self.query(&[], scopes, limit).await
    }

    /// Keyword search: every term must appear in content (case-insensitive),
    /// optionally restricted to scopes.
    pub async fn search(&self, q: &str, scopes: &[String], limit: i64) -> Result<Vec<Memory>> {
        let terms: Vec<String> = q.split_whitespace().map(|t| t.to_string()).collect();
        self.query(&terms, scopes, limit).await
    }

    async fn query(&self, terms: &[String], scopes: &[String], limit: i64) -> Result<Vec<Memory>> {
        let mut sql =
            String::from("SELECT id, content, tags, scope, created_at, updated_at FROM memories");
        let mut wheres: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        for t in terms {
            wheres.push("LOWER(content) LIKE ?".to_string());
            args.push(Value::Text(format!("%{}%", t.to_lowercase())));
        }
        let scopes: Vec<String> = scopes
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !scopes.is_empty() {
            let placeholders = vec!["?"; scopes.len()].join(", ");
            wheres.push(format!("scope IN ({placeholders})"));
            for s in &scopes {
                args.push(Value::Text(s.clone()));
            }
        }
        if !wheres.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wheres.join(" AND "));
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
        args.push(Value::Integer(limit));

        let mut rows = self
            .conn
            .query(&sql, params_from_iter(args))
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let tags_json: String = row.get(2).map_err(db_err)?;
            out.push(Memory {
                id: row.get(0).map_err(db_err)?,
                content: row.get(1).map_err(db_err)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                scope: row.get(3).map_err(db_err)?,
                created_at: row.get(4).map_err(db_err)?,
                updated_at: row.get(5).map_err(db_err)?,
            });
        }
        Ok(out)
    }

    /// Delete a single memory by id. Returns true if a row was removed.
    pub async fn forget(&self, id: i64) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "DELETE FROM memories WHERE id = ?1",
                params_from_iter([Value::Integer(id)]),
            )
            .await
            .map_err(db_err)?;
        Ok(n > 0)
    }

    /// Delete every memory in a scope. Returns the number removed.
    pub async fn purge_scope(&self, scope: &str) -> Result<u64> {
        self.conn
            .execute(
                "DELETE FROM memories WHERE scope = ?1",
                params_from_iter([Value::Text(scope.to_string())]),
            )
            .await
            .map_err(db_err)
    }

    // --- people (pseudonymized identity resolution) -------------------------

    /// Resolve an identifier to an existing person, or `None` if unseen.
    pub async fn lookup_person(
        &self,
        namespace: &str,
        identifier: &str,
    ) -> Result<Option<[u8; 16]>> {
        let bidx = pseudonym::blind_index(&self.pepper, namespace, identifier, BLIND_INDEX_BYTES)?;
        let mut rows = self
            .conn
            .query(
                "SELECT person_id FROM person_identifier WHERE blind_index = ?1 AND namespace = ?2",
                params_from_iter([Value::Blob(bidx), Value::Text(namespace.to_string())]),
            )
            .await
            .map_err(db_err)?;
        if let Some(row) = rows.next().await.map_err(db_err)? {
            let pid: Vec<u8> = row.get(0).map_err(db_err)?;
            Ok(Some(to_uuid16(&pid)?))
        } else {
            Ok(None)
        }
    }

    /// Resolve an identifier to a person, minting a new opaque person if unseen.
    pub async fn resolve_or_create_person(
        &self,
        namespace: &str,
        identifier: &str,
    ) -> Result<[u8; 16]> {
        if let Some(p) = self.lookup_person(namespace, identifier).await? {
            return Ok(p);
        }
        let pid = Uuid::new_v4();
        let pid_bytes = pid.as_bytes().to_vec();
        let now = now_millis();
        self.conn
            .execute(
                "INSERT INTO person (person_id, created_at) VALUES (?1, ?2)",
                params_from_iter([Value::Blob(pid_bytes.clone()), Value::Integer(now)]),
            )
            .await
            .map_err(db_err)?;
        self.write_identifier(&pid_bytes, namespace, identifier, now)
            .await?;
        Ok(*pid.as_bytes())
    }

    /// Link another identifier (e.g. a second platform handle) to a known person.
    pub async fn link_identifier(
        &self,
        person_id: &[u8; 16],
        namespace: &str,
        identifier: &str,
    ) -> Result<()> {
        self.write_identifier(&person_id.to_vec(), namespace, identifier, now_millis())
            .await
    }

    async fn write_identifier(
        &self,
        person_id: &[u8],
        namespace: &str,
        identifier: &str,
        now: i64,
    ) -> Result<()> {
        let bidx = pseudonym::blind_index(&self.pepper, namespace, identifier, BLIND_INDEX_BYTES)?;
        let enc_id = crypto::seal(
            &self.field_key,
            identifier.as_bytes(),
            &aad(b"identifier", person_id),
        )?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO person_identifier \
                 (blind_index, namespace, person_id, enc_identifier, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params_from_iter([
                    Value::Blob(bidx),
                    Value::Text(namespace.to_string()),
                    Value::Blob(person_id.to_vec()),
                    Value::Blob(enc_id),
                    Value::Integer(now),
                ]),
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    /// Attach an encrypted attribute (note/tier/observation) to a person.
    pub async fn add_attribute(
        &self,
        person_id: &[u8; 16],
        attr_type: &str,
        value: &str,
        expires_at: Option<i64>,
    ) -> Result<[u8; 16]> {
        let attr = Uuid::new_v4();
        let attr_bytes = attr.as_bytes().to_vec();
        let mut ctx = person_id.to_vec();
        ctx.extend_from_slice(&attr_bytes);
        let enc = crypto::seal(&self.field_key, value.as_bytes(), &aad(attr_type.as_bytes(), &ctx))?;
        let now = now_millis();
        self.conn
            .execute(
                "INSERT INTO person_attribute \
                 (attr_id, person_id, attr_type, enc_value, created_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params_from_iter([
                    Value::Blob(attr_bytes),
                    Value::Blob(person_id.to_vec()),
                    Value::Text(attr_type.to_string()),
                    Value::Blob(enc),
                    Value::Integer(now),
                    expires_at.map(Value::Integer).unwrap_or(Value::Null),
                ]),
            )
            .await
            .map_err(db_err)?;
        Ok(*attr.as_bytes())
    }

    /// Decrypt all attributes for a person, oldest-first, as `(type, value)`.
    pub async fn get_attributes(&self, person_id: &[u8; 16]) -> Result<Vec<(String, String)>> {
        let mut rows = self
            .conn
            .query(
                "SELECT attr_id, attr_type, enc_value FROM person_attribute \
                 WHERE person_id = ?1 ORDER BY created_at ASC",
                params_from_iter([Value::Blob(person_id.to_vec())]),
            )
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let attr_id: Vec<u8> = row.get(0).map_err(db_err)?;
            let attr_type: String = row.get(1).map_err(db_err)?;
            let enc: Vec<u8> = row.get(2).map_err(db_err)?;
            let mut ctx = person_id.to_vec();
            ctx.extend_from_slice(&attr_id);
            let pt = crypto::open(&self.field_key, &enc, &aad(attr_type.as_bytes(), &ctx))?;
            out.push((attr_type, String::from_utf8_lossy(&pt).into_owned()));
        }
        Ok(out)
    }

    /// Right-to-forget: destroy a person's entire footprint (identifiers +
    /// attributes + the person row).
    pub async fn forget_person(&self, person_id: &[u8; 16]) -> Result<()> {
        let p = person_id.to_vec();
        for sql in [
            "DELETE FROM person_attribute WHERE person_id = ?1",
            "DELETE FROM person_identifier WHERE person_id = ?1",
            "DELETE FROM person WHERE person_id = ?1",
        ] {
            self.conn
                .execute(sql, params_from_iter([Value::Blob(p.clone())]))
                .await
                .map_err(db_err)?;
        }
        Ok(())
    }
}

// --- helpers ----------------------------------------------------------------

fn normalize_scope(scope: Option<&str>) -> String {
    match scope {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => DEFAULT_SCOPE.to_string(),
    }
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        if seen.insert(t.to_lowercase()) {
            out.push(t.to_string());
        }
    }
    out
}

/// Build AEAD associated-data binding a ciphertext to its storage context.
fn aad(kind: &[u8], id: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(14 + kind.len() + 1 + id.len());
    v.extend_from_slice(b"cognitive-mcp:");
    v.extend_from_slice(kind);
    v.push(0x1F);
    v.extend_from_slice(id);
    v
}

fn to_uuid16(b: &[u8]) -> Result<[u8; 16]> {
    if b.len() != 16 {
        return Err(Error::Db("person_id is not 16 bytes".into()));
    }
    let mut a = [0u8; 16];
    a.copy_from_slice(b);
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn open_tmp() -> (tempfile::TempDir, Store) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mem.db");
        let store = Store::open(
            path.to_str().unwrap(),
            Key::random(),
            b"test-pepper".to_vec(),
        )
        .await
        .unwrap();
        (dir, store)
    }

    #[tokio::test]
    async fn scope_isolation_and_purge() {
        let (_d, s) = open_tmp().await;
        s.store_memory("default note", &[], None).await.unwrap();
        s.store_memory("cb note", &[], Some("agent:cb")).await.unwrap();
        s.store_memory("of note", &[], Some("agent:of")).await.unwrap();

        let all = s.list(&[], 100).await.unwrap();
        assert_eq!(all.len(), 3);

        let only_cb = s.list(&["agent:cb".to_string()], 100).await.unwrap();
        assert_eq!(only_cb.len(), 1);
        assert_eq!(only_cb[0].content, "cb note");

        let multi = s
            .list(&["agent:cb".to_string(), "agent:of".to_string()], 100)
            .await
            .unwrap();
        assert_eq!(multi.len(), 2);

        let removed = s.purge_scope("agent:cb").await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(s.list(&["agent:cb".to_string()], 100).await.unwrap().len(), 0);
        assert_eq!(s.list(&["agent:of".to_string()], 100).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn search_and_forget() {
        let (_d, s) = open_tmp().await;
        let m = s.store_memory("deploy on fridays", &[], None).await.unwrap();
        s.store_memory("unrelated", &[], None).await.unwrap();

        assert_eq!(s.search("deploy", &[], 100).await.unwrap().len(), 1);
        assert_eq!(s.search("deploy fridays", &[], 100).await.unwrap().len(), 1); // AND
        assert_eq!(s.search("deploy nonexistent", &[], 100).await.unwrap().len(), 0);

        assert!(s.forget(m.id).await.unwrap());
        assert!(!s.forget(m.id).await.unwrap()); // idempotent
        assert_eq!(s.list(&[], 100).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn person_resolution_is_idempotent_and_cross_platform() {
        let (_d, s) = open_tmp().await;

        let p1 = s.resolve_or_create_person("handle:cb", "RoyalFan").await.unwrap();
        let p1_again = s.resolve_or_create_person("handle:cb", "royalfan").await.unwrap();
        assert_eq!(p1, p1_again); // normalization + idempotence

        // unknown identifier in another namespace -> no match yet
        assert!(s.lookup_person("of:user", "royal_fan").await.unwrap().is_none());

        // link the OF identity to the SAME person; now it resolves cross-platform
        s.link_identifier(&p1, "of:user", "royal_fan").await.unwrap();
        let p_of = s.lookup_person("of:user", "royal_fan").await.unwrap();
        assert_eq!(p_of, Some(p1));

        // a different person is distinct
        let p2 = s.resolve_or_create_person("handle:cb", "SomeoneElse").await.unwrap();
        assert_ne!(p1, p2);
    }

    #[tokio::test]
    async fn attributes_roundtrip_and_forget_person() {
        let (_d, s) = open_tmp().await;
        let p = s.resolve_or_create_person("handle:cb", "fan").await.unwrap();
        s.add_attribute(&p, "note", "high-value cross-platform lead", None)
            .await
            .unwrap();
        s.add_attribute(&p, "tier", "warm", None).await.unwrap();

        let attrs = s.get_attributes(&p).await.unwrap();
        assert_eq!(attrs.len(), 2);
        assert!(attrs.iter().any(|(t, v)| t == "note" && v.contains("high-value")));

        s.forget_person(&p).await.unwrap();
        assert!(s.get_attributes(&p).await.unwrap().is_empty());
        assert!(s.lookup_person("handle:cb", "fan").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn database_file_is_encrypted_at_rest() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("enc.db");
        let path_str = path.to_str().unwrap().to_string();
        let marker = "SUPER_SECRET_PLAINTEXT_MARKER_42";
        {
            let s = Store::open(&path_str, Key::random(), b"pep".to_vec())
                .await
                .unwrap();
            s.store_memory(marker, &[], None).await.unwrap();
            // store drops here -> connection + db closed, bytes flushed
        }
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.is_empty());
        // the plaintext marker must NOT appear anywhere in the on-disk file
        let needle = marker.as_bytes();
        let found = bytes.windows(needle.len()).any(|w| w == needle);
        assert!(!found, "plaintext leaked into the encrypted database file");
    }
}
