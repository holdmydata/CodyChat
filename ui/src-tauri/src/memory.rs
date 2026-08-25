//! Local vector-memory store ("the brain") — persists chat message and
//! document text plus embeddings in a local SQLite database (via the
//! sqlite-vec loadable extension), so the model can retrieve relevant past
//! context through a real tool call (search_memory, see
//! skills.rs::get_tool_definitions), gated by the same approval prompt every
//! other tool already goes through. Chosen over a hosted vector DB / Neo4j
//! specifically to avoid a separate always-running server process, matching
//! this app's existing local-only posture (see docs/MEMORY.md's 2026-08-16
//! "Memory/RAG backend decided" entry).
//!
//! Schema uses vec0's own native metadata/partition-key/auxiliary column
//! support (confirmed against https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/)
//! rather than a separate joined table — `source_type` is a partition key
//! (shards the index, so a type-scoped search like "only my PDFs" searches
//! one shard instead of everything), `conversation_id`/`role`/`created_at`
//! are plain filterable metadata columns, and `message_id`/`source_path`/
//! `content` are auxiliary (`+`-prefixed) columns: retrievable but never
//! filterable, the correct home for large unindexed text payloads.
//!
//! Rust never talks to Ollama directly (same posture as skills.rs/mcp.rs) —
//! embeddings are computed by the frontend (lib/ollama.ts::embedText) and
//! passed in already-computed. The commands here only ever see plain f32
//! vectors, never text to embed; the model-facing search_memory tool (in
//! get_tool_definitions) takes a plain `query: string` — it's
//! lib/skills.ts::executeSkill that bridges the two by embedding first.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

// nomic-embed-text's output size. Switching embedding models later means a
// dimension change, which needs dropping and fully re-embedding
// memory_items — no migration path exists for that yet (see docs/MEMORY.md).
pub const EMBED_DIM: usize = 768;

pub struct MemoryState(pub Mutex<Connection>);

// The vec0 loadable extension, loaded per-connection at runtime rather than
// compiled from source. The `sqlite-vec` crate published on crates.io
// (0.1.10-alpha.4, the only version available) turned out to have a real
// upstream packaging bug: its bundled `sqlite-vec.c` #includes
// sqlite-vec-diskann.c/-ivf.c/-ivf-kmeans.c/-rescore.c, none of which are
// actually shipped in the crate — confirmed against the real GitHub repo,
// and the project's own "amalgamation" release asset has the identical gap,
// so this isn't a crates.io-packaging-only issue. Using the officially
// published precompiled loadable extension (the same release's
// `*-loadable-windows-x86_64.tar.gz` asset, vendored at resources/vec0.dll)
// sidesteps compiling that broken source entirely.
//
// Path is CARGO_MANIFEST_DIR-relative, baked in at compile time — correct
// for `cargo build`/`tauri dev` on this machine, same tradeoff already
// documented for get_environment_info's project_root (commands.rs).
// Packaged-build resource resolution (via Tauri's resource_dir(), so a real
// installer carries vec0.dll correctly) is a real, flagged gap — not wired
// up in this pass.
fn vec_extension_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("vec0.dll")
}

fn load_vec_extension(conn: &Connection) -> Result<(), String> {
    let path = vec_extension_path();
    unsafe {
        conn.load_extension_enable().map_err(|e| e.to_string())?;
        let result = conn.load_extension(&path, None);
        conn.load_extension_disable().map_err(|e| e.to_string())?;
        result.map_err(|e| format!("failed to load vec0 extension from {}: {e}", path.display()))
    }
}

// vec0 virtual tables reject ALTER TABLE outright ("virtual tables may not
// be altered" — confirmed live against the real vendored extension, not
// assumed) so a new column needs a full rebuild: rename the old table,
// create the new schema under the real name, copy every row across (the
// embedding column is a plain BLOB either way, so a raw copy round-trips
// it correctly — confirmed with a real KNN search against migrated data
// during that same check), then drop the renamed original. Runs at most
// once per real schema change, guarded by has_conversation_subject_column
// below so a fresh (already-current) DB never pays this cost.
fn migrate_add_conversation_subject_column(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "ALTER TABLE memory_items RENAME TO memory_items_pre_subject;
        CREATE VIRTUAL TABLE memory_items USING vec0(
            item_id         INTEGER PRIMARY KEY,
            embedding       float[{EMBED_DIM}],
            source_type     TEXT partition key,
            conversation_id TEXT,
            role            TEXT,
            created_at      INTEGER,
            +message_id     TEXT,
            +source_path    TEXT,
            +content        TEXT,
            +conversation_subject TEXT
        );
        INSERT INTO memory_items
            (item_id, embedding, source_type, conversation_id, role, created_at, message_id, source_path, content, conversation_subject)
        SELECT item_id, embedding, source_type, conversation_id, role, created_at, message_id, source_path, content, ''
        FROM memory_items_pre_subject;
        DROP TABLE memory_items_pre_subject;"
    ))
}

// prepare() alone is enough to detect this — SQLite validates column names
// against the table's declared schema at prepare time, before touching any
// row data, so this correctly returns false against an empty (0-row) table
// too, unlike a query-and-check-for-a-result approach would.
fn has_conversation_subject_column(conn: &Connection) -> bool {
    conn.prepare("SELECT conversation_subject FROM memory_items LIMIT 0").is_ok()
}

// A CREATE VIRTUAL TABLE still registers as type='table' in sqlite_master —
// SQLite has no separate 'virtual' type value there.
fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
}

fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS vec_messages;",
    )?;

    if table_exists(conn, "memory_items")? && !has_conversation_subject_column(conn) {
        migrate_add_conversation_subject_column(conn)?;
    }

    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_items USING vec0(
            item_id         INTEGER PRIMARY KEY,
            embedding       float[{EMBED_DIM}],
            source_type     TEXT partition key,
            conversation_id TEXT,
            role            TEXT,
            created_at      INTEGER,
            +message_id     TEXT,
            +source_path    TEXT,
            +content        TEXT,
            +conversation_subject TEXT
        );"
    ))
}

/// Creates `dir` if missing, opens (or creates) `memory.sqlite3` inside it,
/// and ensures the schema exists. Kept standalone (not inlined into
/// lib.rs's `.setup()`) so it's testable with `Connection::open_in_memory()`
/// without needing a real Tauri `AppHandle`.
pub fn init_db(dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    let conn = Connection::open(dir.join("memory.sqlite3")).map_err(|e| e.to_string())?;
    load_vec_extension(&conn)?;
    create_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn embedding_to_bytes(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|f| f.to_le_bytes()).collect()
}

#[allow(clippy::too_many_arguments)]
fn index_item_in(
    conn: &Connection,
    source_type: &str,
    conversation_id: &str,
    role: &str,
    message_id: &str,
    source_path: &str,
    content: &str,
    created_at: i64,
    embedding: &[f32],
) -> Result<(), String> {
    // Manual dedup rather than a declarative UNIQUE constraint — vec0's
    // support for compound uniqueness isn't confirmed by its docs, and a
    // pre-insert existence check works regardless of whether it turns out
    // to be supported. Keyed on (source_type, message_id): message_id holds
    // the app's own chat Message.id for chat sources, or the file path for
    // document sources (see indexDocument in lib/memory.ts) — unique enough
    // within a given source_type either way.
    let exists = conn
        .query_row(
            "SELECT 1 FROM memory_items WHERE source_type = ?1 AND message_id = ?2 LIMIT 1",
            params![source_type, message_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if exists {
        return Ok(());
    }

    // conversation_subject starts empty at index time — it's only known
    // once someone (the Sidebar's per-conversation button, or the graph's
    // bulk Classify action) actually generates one, which happens well
    // after a conversation's messages are first indexed. Backfilled via
    // update_conversation_subject_in below, keyed on conversation_id, once
    // it exists.
    conn.execute(
        "INSERT INTO memory_items (embedding, source_type, conversation_id, role, created_at, message_id, source_path, content, conversation_subject)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '')",
        params![
            embedding_to_bytes(embedding),
            source_type,
            conversation_id,
            role,
            created_at,
            message_id,
            source_path,
            content
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// Backfills every existing memory_item for a conversation once a subject
// exists — see index_item_in's comment for why this is a separate,
// after-the-fact step rather than something index_item_in ever has to know
// about. Empty conversation_id items (documents indexed via indexDocument,
// not a chat) are never touched since nothing matches that filter.
//
// Two-step (select ids, then update each by item_id) rather than one
// `UPDATE ... WHERE conversation_id = ?` — confirmed live against the real
// vec0 extension that the direct form fails with "UPDATE on partition key
// columns are not supported yet," a confusing error since conversation_id
// isn't the partition key (source_type is); whatever the underlying vec0
// limitation actually is, filtering by item_id (the real primary key)
// instead is confirmed to work.
fn update_conversation_subject_in(conn: &Connection, conversation_id: &str, subject: &str) -> Result<u64, String> {
    let mut stmt = conn
        .prepare("SELECT item_id FROM memory_items WHERE conversation_id = ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = stmt
        .query_map(params![conversation_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    for id in &ids {
        conn.execute(
            "UPDATE memory_items SET conversation_subject = ?1 WHERE item_id = ?2",
            params![subject, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(ids.len() as u64)
}

#[derive(Serialize)]
pub struct MemoryMatch {
    source_type: String,
    conversation_id: String,
    role: String,
    created_at: i64,
    message_id: String,
    source_path: String,
    content: String,
    conversation_subject: String,
    distance: f64,
}

fn search_memory_in(
    conn: &Connection,
    embedding: &[f32],
    top_k: u32,
    source_type: Option<&str>,
    exclude_conversation_id: Option<&str>,
) -> Result<Vec<MemoryMatch>, String> {
    let top_k = top_k.max(1);

    // Built dynamically rather than encoding optionality into one static
    // SQL string (e.g. "AND (?3 IS NULL OR source_type = ?3)") — the vec0
    // MATCH/k KNN constraint's query-planner behavior around conditional
    // filters isn't something this project has verified, and a plain
    // conditionally-appended WHERE fragment is a well-understood pattern
    // that avoids relying on it.
    let mut sql = String::from(
        "SELECT source_type, conversation_id, role, created_at, message_id, source_path, content, conversation_subject, distance
         FROM memory_items
         WHERE embedding MATCH ?1 AND k = ?2",
    );
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(embedding_to_bytes(embedding)), Box::new(top_k)];

    if let Some(st) = source_type {
        bound.push(Box::new(st.to_string()));
        sql.push_str(&format!(" AND source_type = ?{}", bound.len()));
    }
    if let Some(excl) = exclude_conversation_id {
        bound.push(Box::new(excl.to_string()));
        sql.push_str(&format!(" AND conversation_id != ?{}", bound.len()));
    }
    sql.push_str(" ORDER BY distance");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(MemoryMatch {
                source_type: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                created_at: row.get(3)?,
                message_id: row.get(4)?,
                source_path: row.get(5)?,
                content: row.get(6)?,
                conversation_subject: row.get(7)?,
                distance: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|e| e.to_string())?);
    }
    Ok(matches)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub fn index_memory_item(
    state: State<MemoryState>,
    source_type: String,
    conversation_id: String,
    role: String,
    message_id: String,
    source_path: String,
    content: String,
    created_at: i64,
    embedding: Vec<f32>,
) -> Result<(), String> {
    if embedding.len() != EMBED_DIM {
        return Err(format!("expected {EMBED_DIM}-dim embedding, got {}", embedding.len()));
    }
    let conn = state.0.lock().map_err(|_| "memory DB lock poisoned".to_string())?;
    index_item_in(
        &conn,
        &source_type,
        &conversation_id,
        &role,
        &message_id,
        &source_path,
        &content,
        created_at,
        &embedding,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_memory_conversation_subject(
    state: State<MemoryState>,
    conversation_id: String,
    subject: String,
) -> Result<u64, String> {
    let conn = state.0.lock().map_err(|_| "memory DB lock poisoned".to_string())?;
    update_conversation_subject_in(&conn, &conversation_id, &subject)
}

#[tauri::command(rename_all = "snake_case")]
pub fn search_memory(
    state: State<MemoryState>,
    embedding: Vec<f32>,
    top_k: u32,
    source_type: Option<String>,
    exclude_conversation_id: Option<String>,
) -> Result<Vec<MemoryMatch>, String> {
    if embedding.len() != EMBED_DIM {
        return Err(format!("expected {EMBED_DIM}-dim embedding, got {}", embedding.len()));
    }
    let conn = state.0.lock().map_err(|_| "memory DB lock poisoned".to_string())?;
    search_memory_in(
        &conn,
        &embedding,
        top_k,
        source_type.as_deref(),
        exclude_conversation_id.as_deref(),
    )
}

#[derive(Serialize)]
pub struct MemoryItemDetail {
    item_id: i64,
    source_type: String,
    conversation_id: String,
    role: String,
    message_id: String,
    source_path: String,
    content: String,
    created_at: i64,
}

fn get_memory_item_in(conn: &Connection, item_id: i64) -> Result<MemoryItemDetail, String> {
    conn.query_row(
        "SELECT item_id, source_type, conversation_id, role, message_id, source_path, content, created_at
         FROM memory_items WHERE item_id = ?1",
        params![item_id],
        |row| {
            Ok(MemoryItemDetail {
                item_id: row.get(0)?,
                source_type: row.get(1)?,
                conversation_id: row.get(2)?,
                role: row.get(3)?,
                message_id: row.get(4)?,
                source_path: row.get(5)?,
                content: row.get(6)?,
                created_at: row.get(7)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn delete_memory_item_in(conn: &Connection, item_id: i64) -> Result<(), String> {
    let deleted = conn
        .execute("DELETE FROM memory_items WHERE item_id = ?1", params![item_id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("no memory item with id {item_id}"));
    }
    Ok(())
}

// Full, untruncated fetch for a single item — the graph view's node
// payload truncates content for a lightweight overview; this is the
// on-demand "open the real thing" call the detail panel uses instead of
// relying on that truncated copy.
#[tauri::command(rename_all = "snake_case")]
pub fn get_memory_item(state: State<MemoryState>, item_id: i64) -> Result<MemoryItemDetail, String> {
    let conn = state.0.lock().map_err(|_| "memory DB lock poisoned".to_string())?;
    get_memory_item_in(&conn, item_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn delete_memory_item(state: State<MemoryState>, item_id: i64) -> Result<(), String> {
    let conn = state.0.lock().map_err(|_| "memory DB lock poisoned".to_string())?;
    delete_memory_item_in(&conn, item_id)
}

#[derive(Serialize)]
pub struct MemoryGraphNode {
    item_id: i64,
    source_type: String,
    conversation_id: String,
    content: String,
    created_at: i64,
}

#[derive(Serialize)]
pub struct MemoryGraphEdge {
    from: i64,
    to: i64,
    distance: f64,
}

#[derive(Serialize)]
pub struct MemoryGraph {
    nodes: Vec<MemoryGraphNode>,
    edges: Vec<MemoryGraphEdge>,
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

struct GraphRow {
    item_id: i64,
    source_type: String,
    conversation_id: String,
    content: String,
    created_at: i64,
    embedding: Vec<u8>,
}

fn build_memory_graph_in(conn: &Connection, neighbors_per_node: u32) -> Result<MemoryGraph, String> {
    let k = neighbors_per_node.max(1);

    let mut stmt = conn
        .prepare("SELECT item_id, source_type, conversation_id, content, created_at, embedding FROM memory_items")
        .map_err(|e| e.to_string())?;
    let rows: Vec<GraphRow> = stmt
        .query_map([], |row| {
            Ok(GraphRow {
                item_id: row.get(0)?,
                source_type: row.get(1)?,
                conversation_id: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                embedding: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    let nodes = rows
        .iter()
        .map(|r| MemoryGraphNode {
            item_id: r.item_id,
            source_type: r.source_type.clone(),
            conversation_id: r.conversation_id.clone(),
            content: truncate_chars(&r.content, 200),
            created_at: r.created_at,
        })
        .collect();

    // Over-fetch (k+1) and filter the self-match out in Rust rather than
    // adding an `AND item_id != ?` clause to the KNN query — this project's
    // own search_memory_in already avoids relying on how vec0's MATCH/k
    // constraint interacts with additional WHERE filters (unverified
    // behavior), and this is the same already-proven workaround.
    let mut edge_stmt = conn
        .prepare("SELECT item_id, distance FROM memory_items WHERE embedding MATCH ?1 AND k = ?2")
        .map_err(|e| e.to_string())?;

    let mut seen_edges = std::collections::HashSet::new();
    let mut edges = Vec::new();
    for r in &rows {
        let neighbor_rows = edge_stmt
            .query_map(params![r.embedding, k + 1], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut taken = 0u32;
        for nr in neighbor_rows {
            let (neighbor_id, distance) = nr.map_err(|e| e.to_string())?;
            if neighbor_id == r.item_id {
                continue;
            }
            if taken >= k {
                break;
            }
            taken += 1;
            let key = (r.item_id.min(neighbor_id), r.item_id.max(neighbor_id));
            if seen_edges.insert(key) {
                edges.push(MemoryGraphEdge { from: r.item_id, to: neighbor_id, distance });
            }
        }
    }

    Ok(MemoryGraph { nodes, edges })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_memory_graph(state: State<MemoryState>, neighbors_per_node: u32) -> Result<MemoryGraph, String> {
    let conn = state.0.lock().map_err(|_| "memory DB lock poisoned".to_string())?;
    build_memory_graph_in(&conn, neighbors_per_node)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        load_vec_extension(&conn).unwrap();
        create_schema(&conn).unwrap();
        conn
    }

    // Not a real embedding — just a deterministic 768-length vector whose
    // closeness to another dummy vector is controllable via `seed`, enough
    // to exercise KNN ordering without needing a real model.
    fn dummy_embedding(seed: f32) -> Vec<f32> {
        (0..EMBED_DIM).map(|i| seed + i as f32 * 0.0001).collect()
    }

    #[test]
    fn schema_migration_preserves_existing_rows_and_adds_working_subject_column() {
        // Simulates a real pre-existing DB from before conversation_subject
        // existed: build the old-shape table directly (bypassing
        // create_schema, which always builds the current/new shape) and
        // index a row into it, then run create_schema again — the same
        // call init_db makes on every launch — and confirm the row
        // survived, KNN search still works, and the new column is usable.
        let conn = Connection::open_in_memory().unwrap();
        load_vec_extension(&conn).unwrap();
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE memory_items USING vec0(
                item_id         INTEGER PRIMARY KEY,
                embedding       float[{EMBED_DIM}],
                source_type     TEXT partition key,
                conversation_id TEXT,
                role            TEXT,
                created_at      INTEGER,
                +message_id     TEXT,
                +source_path    TEXT,
                +content        TEXT
            );"
        ))
        .unwrap();
        conn.execute(
            "INSERT INTO memory_items (embedding, source_type, conversation_id, role, created_at, message_id, source_path, content)
             VALUES (?1, 'chat_message', 'conv-a', 'user', 1000, 'msg-1', '', 'pre-migration row')",
            params![embedding_to_bytes(&dummy_embedding(1.0))],
        )
        .unwrap();

        assert!(!has_conversation_subject_column(&conn));
        create_schema(&conn).unwrap();
        assert!(has_conversation_subject_column(&conn));

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "the pre-existing row must survive the migration");

        let results = search_memory_in(&conn, &dummy_embedding(1.0), 1, None, None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "pre-migration row");
        assert_eq!(results[0].conversation_subject, "", "migrated rows default to an empty (not-yet-labeled) subject");

        // A second create_schema call (e.g. a normal second app launch)
        // must be a no-op, not attempt the migration again.
        create_schema(&conn).unwrap();
        let count_after: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
        assert_eq!(count_after, 1);
    }

    #[test]
    fn update_conversation_subject_backfills_matching_rows_only() {
        let conn = test_conn();
        index_item_in(&conn, "chat_message", "conv-a", "user", "a1", "", "in conv a", 1000, &dummy_embedding(1.0))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-a", "assistant", "a2", "", "also conv a", 1001, &dummy_embedding(1.0001))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-b", "user", "b1", "", "in conv b", 1002, &dummy_embedding(1.0002))
            .unwrap();

        let updated = update_conversation_subject_in(&conn, "conv-a", "Fixing Login Timeout Bug").unwrap();
        assert_eq!(updated, 2, "both conv-a rows should be backfilled, not conv-b's");

        let results = search_memory_in(&conn, &dummy_embedding(1.0), 3, None, None).unwrap();
        let subject_for = |content: &str| {
            results.iter().find(|m| m.content == content).unwrap().conversation_subject.clone()
        };
        assert_eq!(subject_for("in conv a"), "Fixing Login Timeout Bug");
        assert_eq!(subject_for("also conv a"), "Fixing Login Timeout Bug");
        assert_eq!(subject_for("in conv b"), "");
    }

    #[test]
    fn index_and_search_roundtrip() {
        let conn = test_conn();
        index_item_in(
            &conn,
            "chat_message",
            "conv-a",
            "user",
            "msg-1",
            "",
            "what's my favorite color?",
            1000,
            &dummy_embedding(1.0),
        )
        .unwrap();
        index_item_in(
            &conn,
            "chat_message",
            "conv-a",
            "assistant",
            "msg-2",
            "",
            "it's blue",
            1001,
            &dummy_embedding(1.0001),
        )
        .unwrap();
        index_item_in(
            &conn,
            "chat_message",
            "conv-b",
            "user",
            "msg-3",
            "",
            "totally unrelated topic",
            2000,
            &dummy_embedding(50.0),
        )
        .unwrap();

        let results = search_memory_in(&conn, &dummy_embedding(1.0), 2, None, None).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|m| m.content == "what's my favorite color?"));
        assert!(results.iter().any(|m| m.content == "it's blue"));
        // Nearest match first.
        assert_eq!(results[0].content, "what's my favorite color?");
    }

    #[test]
    fn search_excludes_given_conversation() {
        let conn = test_conn();
        index_item_in(&conn, "chat_message", "conv-a", "user", "msg-1", "", "self", 1000, &dummy_embedding(1.0))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-b", "user", "msg-2", "", "other", 2000, &dummy_embedding(1.0001))
            .unwrap();

        let results = search_memory_in(&conn, &dummy_embedding(1.0), 5, None, Some("conv-a")).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].conversation_id, "conv-b");
    }

    #[test]
    fn search_filters_by_source_type_partition_key() {
        let conn = test_conn();
        index_item_in(
            &conn,
            "chat_message",
            "conv-a",
            "user",
            "msg-1",
            "",
            "a chat about ducks",
            1000,
            &dummy_embedding(1.0),
        )
        .unwrap();
        index_item_in(
            &conn,
            "pdf",
            "",
            "",
            "C:\\docs\\ducks.pdf",
            "C:\\docs\\ducks.pdf",
            "a PDF about ducks",
            1001,
            &dummy_embedding(1.0001),
        )
        .unwrap();

        let pdf_only = search_memory_in(&conn, &dummy_embedding(1.0), 5, Some("pdf"), None).unwrap();
        assert_eq!(pdf_only.len(), 1);
        assert_eq!(pdf_only[0].source_type, "pdf");

        let everything = search_memory_in(&conn, &dummy_embedding(1.0), 5, None, None).unwrap();
        assert_eq!(everything.len(), 2);
    }

    #[test]
    fn reindexing_same_source_type_and_message_id_is_idempotent() {
        let conn = test_conn();
        index_item_in(&conn, "chat_message", "conv-a", "user", "msg-1", "", "first", 1000, &dummy_embedding(1.0))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-a", "user", "msg-1", "", "first", 1000, &dummy_embedding(1.0))
            .unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn search_returns_nothing_on_empty_db() {
        let conn = test_conn();
        let results = search_memory_in(&conn, &dummy_embedding(1.0), 5, None, None).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn memory_graph_connects_true_nearest_neighbors() {
        let conn = test_conn();
        // Two tight clusters (seeds 1.0/1.0001 and 20.0/20.0001) plus one
        // far outlier (200.0). Real finding from this test failing on its
        // first version: plain top-k KNN has no distance floor — it always
        // returns the k closest points no matter how far away they
        // actually are, so at k=1 the outlier is *guaranteed* to connect to
        // its least-bad option (some cluster member), not float freely
        // unconnected. That's correct KNN behavior, not a bug — a real
        // product consideration for later (once there's actual usage data
        // to calibrate a sensible distance cutoff against, not a guessed
        // magic number), not solved in this pass. What's actually testable
        // here is that each cluster's two members are genuinely closer to
        // each other than to anything else, so they end up connected.
        index_item_in(&conn, "chat_message", "conv-a", "user", "a1", "", "cluster a 1", 1000, &dummy_embedding(1.0))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-a", "user", "a2", "", "cluster a 2", 1001, &dummy_embedding(1.0001))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-b", "user", "b1", "", "cluster b 1", 1002, &dummy_embedding(20.0))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-b", "user", "b2", "", "cluster b 2", 1003, &dummy_embedding(20.0001))
            .unwrap();
        index_item_in(&conn, "chat_message", "conv-c", "user", "c1", "", "outlier", 1004, &dummy_embedding(200.0))
            .unwrap();

        let graph = build_memory_graph_in(&conn, 1).unwrap();
        assert_eq!(graph.nodes.len(), 5);
        assert!(!graph.edges.is_empty());

        let id_of = |content: &str| graph.nodes.iter().find(|n| n.content == content).unwrap().item_id;
        let has_edge = |a: i64, b: i64| graph.edges.iter().any(|e| (e.from, e.to) == (a, b) || (e.from, e.to) == (b, a));

        assert!(has_edge(id_of("cluster a 1"), id_of("cluster a 2")), "a1/a2 are each other's true nearest neighbor");
        assert!(has_edge(id_of("cluster b 1"), id_of("cluster b 2")), "b1/b2 are each other's true nearest neighbor");
    }

    #[test]
    fn get_memory_item_returns_full_untruncated_content() {
        let conn = test_conn();
        let long_content = "x".repeat(500);
        index_item_in(&conn, "chat_message", "conv-a", "user", "msg-1", "", &long_content, 1000, &dummy_embedding(1.0))
            .unwrap();
        let item_id: i64 = conn.query_row("SELECT item_id FROM memory_items", [], |r| r.get(0)).unwrap();

        let detail = get_memory_item_in(&conn, item_id).unwrap();
        assert_eq!(detail.content, long_content);
        assert_eq!(detail.content.len(), 500);
    }

    #[test]
    fn get_memory_item_errors_on_unknown_id() {
        let conn = test_conn();
        assert!(get_memory_item_in(&conn, 999).is_err());
    }

    #[test]
    fn delete_memory_item_removes_the_row() {
        let conn = test_conn();
        index_item_in(&conn, "chat_message", "conv-a", "user", "msg-1", "", "gone soon", 1000, &dummy_embedding(1.0))
            .unwrap();
        let item_id: i64 = conn.query_row("SELECT item_id FROM memory_items", [], |r| r.get(0)).unwrap();

        delete_memory_item_in(&conn, item_id).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn delete_memory_item_errors_on_unknown_id() {
        let conn = test_conn();
        assert!(delete_memory_item_in(&conn, 999).is_err());
    }

    #[test]
    fn memory_graph_dedupes_bidirectional_edges() {
        let conn = test_conn();
        index_item_in(&conn, "chat_message", "conv-a", "user", "a1", "", "one", 1000, &dummy_embedding(1.0)).unwrap();
        index_item_in(&conn, "chat_message", "conv-a", "user", "a2", "", "two", 1001, &dummy_embedding(1.0001))
            .unwrap();

        let graph = build_memory_graph_in(&conn, 1).unwrap();
        // Both nodes' single nearest neighbor is each other — without
        // dedup this would produce 2 edges (a1->a2 and a2->a1) instead of 1.
        assert_eq!(graph.edges.len(), 1);
    }

}
