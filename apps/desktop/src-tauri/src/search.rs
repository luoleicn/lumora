// Library full-text search on FTS5. See the section banner below for the
// design; entity writes in db.rs call into this module to keep the index
// synchronous with the entities table.

use tauri::AppHandle;

// --- Library full-text search ------------------------------------------------
// A content-storing FTS5 table holds one row per paper. Title, authors and note
// text are maintained synchronously on every entity write; the PDF body column
// is filled in asynchronously by the frontend extraction backfill and keyed by
// the file's sha256 so re-extraction only happens when the PDF changes. CJK text
// is segmented into single-character tokens (spaces injected around each CJK
// codepoint) at both index and query time, which gives substring semantics for
// CJK phrases while leaving latin tokenization untouched. Soft-deleted papers
// keep their row (flagged `deleted`) so a trashed paper's expensive body column
// survives a restore.

const SEARCH_INDEX_VERSION: &str = "1";
const SEARCH_INDEX_VERSION_META_KEY: &str = "searchIndexVersion";
const SEARCH_RESULT_LIMIT: u32 = 200;
const SEARCH_BODY_MAX_CHARS: usize = 1_000_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    paper_id: String,
    tier: u8,
    score: f64,
    matched_fields: Vec<String>,
    snippet: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BodyIndexStatus {
    paper_id: String,
    body_sha: String,
}

pub(crate) fn ensure_search_index(connection: &rusqlite::Connection) -> Result<(), String> {
    if crate::db::get_meta_value(connection, SEARCH_INDEX_VERSION_META_KEY).as_deref() == Some(SEARCH_INDEX_VERSION) {
        return Ok(());
    }

    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            "DROP TABLE IF EXISTS search_index;
             CREATE VIRTUAL TABLE search_index USING fts5(
               paper_id UNINDEXED,
               title,
               authors,
               body,
               notes,
               body_sha UNINDEXED,
               deleted UNINDEXED,
               tokenize = \"unicode61 remove_diacritics 2\"
             );",
        )
        .map_err(|error| format!("Failed to create search index: {error}"))?;
    rebuild_search_index_rows(&transaction)?;
    crate::db::set_meta_value(&transaction, SEARCH_INDEX_VERSION_META_KEY, SEARCH_INDEX_VERSION)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn rebuild_search_index_rows(connection: &rusqlite::Connection) -> Result<(), String> {
    let notes_by_paper = collect_notes_by_paper(connection)?;

    let mut statement = connection
        .prepare("SELECT id, data, deleted_at FROM entities WHERE entity_type = 'paper'")
        .map_err(|error| error.to_string())?;
    let papers = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for (id, data, deleted_at) in papers {
        let Some(fields) = parse_paper_index_fields(&data) else {
            continue;
        };
        let notes = notes_by_paper
            .get(&id)
            .map(|parts| cjk_segment(&parts.join("\n")))
            .unwrap_or_default();
        connection
            .execute(
                "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
                 VALUES (?1, ?2, ?3, '', ?4, '', ?5)",
                rusqlite::params![id, fields.title, fields.authors, notes, i64::from(deleted_at.is_some())],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn collect_notes_by_paper(
    connection: &rusqlite::Connection,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let mut statement = connection
        .prepare("SELECT data FROM entities WHERE entity_type = 'annotation' AND deleted_at IS NULL")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    let mut notes: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for data in rows {
        let data = data.map_err(|error| error.to_string())?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some(paper_id) = value.get("paperId").and_then(|item| item.as_str()) else {
            continue;
        };
        push_annotation_note_parts(&value, notes.entry(paper_id.to_string()).or_default());
    }
    Ok(notes)
}

fn push_annotation_note_parts(value: &serde_json::Value, parts: &mut Vec<String>) {
    for key in ["quote", "comment"] {
        if let Some(text) = value.get(key).and_then(|item| item.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
}

struct PaperIndexFields {
    title: String,
    authors: String,
}

fn parse_paper_index_fields(data: &str) -> Option<PaperIndexFields> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let title = value.get("title").and_then(|item| item.as_str()).unwrap_or("");
    let authors = value
        .get("authors")
        .and_then(|item| item.as_array())
        .map(|authors| {
            authors
                .iter()
                .filter_map(|author| author.get("fullName").and_then(|name| name.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    Some(PaperIndexFields {
        title: cjk_segment(title),
        authors: cjk_segment(&authors),
    })
}

fn aggregate_notes(connection: &rusqlite::Connection, paper_id: &str) -> Result<String, String> {
    let mut statement = connection
        .prepare(
            "SELECT data FROM entities
             WHERE entity_type = 'annotation' AND deleted_at IS NULL AND json_extract(data, '$.paperId') = ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([paper_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    let mut parts = Vec::new();
    for data in rows {
        let data = data.map_err(|error| error.to_string())?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) {
            push_annotation_note_parts(&value, &mut parts);
        }
    }
    Ok(cjk_segment(&parts.join("\n")))
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        u32::from(ch),
        0x3040..=0x30FF   // Hiragana + Katakana
        | 0x3400..=0x4DBF // CJK extension A
        | 0x4E00..=0x9FFF // CJK unified ideographs
        | 0xAC00..=0xD7AF // Hangul syllables
        | 0xF900..=0xFAFF // CJK compatibility ideographs
    )
}

fn cjk_segment(text: &str) -> String {
    let mut segmented = String::with_capacity(text.len() + text.len() / 2);
    for ch in text.chars() {
        if is_cjk_char(ch) {
            segmented.push(' ');
            segmented.push(ch);
            segmented.push(' ');
        } else {
            segmented.push(ch);
        }
    }
    segmented.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_fts_match_terms(user_query: &str) -> Option<String> {
    let mut phrases: Vec<String> = user_query
        .split_whitespace()
        .filter_map(|term| {
            let segmented = cjk_segment(&term.replace('"', ""));
            (segmented.chars().any(char::is_alphanumeric)).then(|| format!("\"{segmented}\""))
        })
        .collect();

    let last = phrases.last_mut()?;
    let prefixable = last
        .trim_end_matches('"')
        .chars()
        .last()
        .is_some_and(|ch| ch.is_ascii_alphanumeric());
    if prefixable {
        last.push('*');
    }
    Some(phrases.join(" "))
}

fn build_fts_column_query(user_query: &str, column: &str) -> Option<String> {
    build_fts_match_terms(user_query).map(|terms| format!("{{{column}}} : ({terms})"))
}

fn decode_matched_mask(mask: i64) -> Vec<String> {
    [(1, "title"), (2, "body"), (3, "authors"), (4, "notes")]
        .into_iter()
        .filter(|(tier, _)| mask & (1_i64 << tier) != 0)
        .map(|(_, name)| name.to_string())
        .collect()
}

fn search_library_rows(connection: &rusqlite::Connection, query: &str, limit: u32) -> Result<Vec<SearchHit>, String> {
    let (Some(q_title), Some(q_body), Some(q_authors), Some(q_notes)) = (
        build_fts_column_query(query, "title"),
        build_fts_column_query(query, "body"),
        build_fts_column_query(query, "authors"),
        build_fts_column_query(query, "notes"),
    ) else {
        return Ok(Vec::new());
    };

    // Strict tiering: a paper's tier is its highest-priority matching column
    // (title > body > authors > notes); bm25 only orders within a tier. The
    // bare `score`/`snip` columns follow the MIN(tier) row per SQLite's
    // documented bare-column-with-MIN semantics, so the snippet always comes
    // from the best-tier column. Snippet segments are delimited by \u{1}/\u{2}
    // control chars (char(1)/char(2)) that the frontend splits on.
    let sql = "WITH hits(paper_id, tier, score, snip) AS (
         SELECT paper_id, 1, bm25(search_index), snippet(search_index, 1, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_title AND deleted = 0
         UNION ALL
         SELECT paper_id, 2, bm25(search_index), snippet(search_index, 3, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_body AND deleted = 0
         UNION ALL
         SELECT paper_id, 3, bm25(search_index), snippet(search_index, 2, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_authors AND deleted = 0
         UNION ALL
         SELECT paper_id, 4, bm25(search_index), snippet(search_index, 4, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_notes AND deleted = 0
       )
       SELECT paper_id, MIN(tier) AS tier, score, snip, SUM(1 << tier) AS matched_mask
       FROM hits
       GROUP BY paper_id
       ORDER BY tier ASC, score ASC
       LIMIT :limit";

    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let hits = statement
        .query_map(
            rusqlite::named_params! {
                ":q_title": q_title,
                ":q_body": q_body,
                ":q_authors": q_authors,
                ":q_notes": q_notes,
                ":limit": limit,
            },
            |row| {
                Ok(SearchHit {
                    paper_id: row.get(0)?,
                    tier: row.get::<_, i64>(1)? as u8,
                    score: row.get(2)?,
                    matched_fields: decode_matched_mask(row.get::<_, i64>(4)?),
                    snippet: row.get(3)?,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(hits)
}

pub(crate) fn sync_search_index_for_change(
    connection: &rusqlite::Connection,
    entity_type: &str,
    id: &str,
    data: &str,
    deleted_at: Option<&str>,
) -> Result<(), String> {
    match entity_type {
        "paper" => {
            let Some(fields) = parse_paper_index_fields(data) else {
                return Ok(());
            };
            let deleted = i64::from(deleted_at.is_some());
            let updated = connection
                .execute(
                    "UPDATE search_index SET title = ?2, authors = ?3, deleted = ?4 WHERE paper_id = ?1",
                    rusqlite::params![id, fields.title, fields.authors, deleted],
                )
                .map_err(|error| error.to_string())?;
            if updated == 0 {
                let notes = aggregate_notes(connection, id)?;
                connection
                    .execute(
                        "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
                         VALUES (?1, ?2, ?3, '', ?4, '', ?5)",
                        rusqlite::params![id, fields.title, fields.authors, notes, deleted],
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "annotation" => {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                return Ok(());
            };
            let Some(paper_id) = value.get("paperId").and_then(|item| item.as_str()) else {
                return Ok(());
            };
            refresh_paper_notes(connection, paper_id)
        }
        _ => Ok(()),
    }
}

pub(crate) fn refresh_paper_notes(connection: &rusqlite::Connection, paper_id: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;

    let notes = aggregate_notes(connection, paper_id)?;
    let updated = connection
        .execute(
            "UPDATE search_index SET notes = ?2 WHERE paper_id = ?1",
            rusqlite::params![paper_id, notes],
        )
        .map_err(|error| error.to_string())?;
    if updated > 0 {
        return Ok(());
    }

    // Annotations can arrive before their paper's search row exists (sync ordering).
    let paper_row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT data, deleted_at FROM entities WHERE entity_type = 'paper' AND id = ?1",
            [paper_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((data, deleted_at)) = paper_row else {
        return Ok(());
    };
    let Some(fields) = parse_paper_index_fields(&data) else {
        return Ok(());
    };
    connection
        .execute(
            "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
             VALUES (?1, ?2, ?3, '', ?4, '', ?5)",
            rusqlite::params![paper_id, fields.title, fields.authors, notes, i64::from(deleted_at.is_some())],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn index_paper_body(connection: &rusqlite::Connection, paper_id: &str, sha256: &str, text: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;

    let capped: String = text.chars().take(SEARCH_BODY_MAX_CHARS).collect();
    let body = cjk_segment(&capped);
    let updated = connection
        .execute(
            "UPDATE search_index SET body = ?2, body_sha = ?3 WHERE paper_id = ?1",
            rusqlite::params![paper_id, body, sha256],
        )
        .map_err(|error| error.to_string())?;
    if updated > 0 {
        return Ok(());
    }

    let paper_row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT data, deleted_at FROM entities WHERE entity_type = 'paper' AND id = ?1",
            [paper_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((data, deleted_at)) = paper_row else {
        return Ok(());
    };
    let Some(fields) = parse_paper_index_fields(&data) else {
        return Ok(());
    };
    let notes = aggregate_notes(connection, paper_id)?;
    connection
        .execute(
            "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![paper_id, fields.title, fields.authors, body, notes, sha256, i64::from(deleted_at.is_some())],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn db_search_library(app: AppHandle, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>, String> {
    let connection = crate::db::open_library_db(&app)?;
    search_library_rows(&connection, &query, limit.unwrap_or(SEARCH_RESULT_LIMIT))
}

#[tauri::command]
pub(crate) async fn db_index_paper_body(app: AppHandle, paper_id: String, sha256: String, text: String) -> Result<(), String> {
    let connection = crate::db::open_library_db(&app)?;
    index_paper_body(&connection, &paper_id, &sha256, &text)
}

#[tauri::command]
pub(crate) async fn db_search_index_status(app: AppHandle) -> Result<Vec<BodyIndexStatus>, String> {
    let connection = crate::db::open_library_db(&app)?;
    let mut statement = connection
        .prepare("SELECT paper_id, body_sha FROM search_index WHERE deleted = 0")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(BodyIndexStatus {
                paper_id: row.get(0)?,
                body_sha: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::{
        build_fts_column_query, cjk_segment, ensure_search_index, index_paper_body,
        search_library_rows, sync_search_index_for_change, SEARCH_RESULT_LIMIT,
    };
    use crate::db::init_library_schema;

    fn test_connection() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        init_library_schema(&connection).unwrap();
        ensure_search_index(&connection).unwrap();
        connection
    }

    fn upsert_entity(
        connection: &rusqlite::Connection,
        entity_type: &str,
        id: &str,
        data: &str,
        deleted_at: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES (?1, ?2, ?3, '2026-01-01T00:00:00Z', ?4, 0)
                 ON CONFLICT(entity_type, id) DO UPDATE SET data = excluded.data, deleted_at = excluded.deleted_at",
                rusqlite::params![entity_type, id, data, deleted_at],
            )
            .unwrap();
        sync_search_index_for_change(connection, entity_type, id, data, deleted_at).unwrap();
    }

    fn paper_json(id: &str, title: &str, authors: &[&str]) -> String {
        let authors = authors
            .iter()
            .map(|name| format!(r#"{{"fullName":"{name}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        format!(r#"{{"id":"{id}","title":"{title}","authors":[{authors}]}}"#)
    }

    fn annotation_json(id: &str, paper_id: &str, quote: &str, comment: &str) -> String {
        format!(r#"{{"id":"{id}","paperId":"{paper_id}","quote":"{quote}","comment":"{comment}"}}"#)
    }

    fn search_ids(connection: &rusqlite::Connection, query: &str) -> Vec<String> {
        search_library_rows(connection, query, SEARCH_RESULT_LIMIT)
            .unwrap()
            .into_iter()
            .map(|hit| hit.paper_id)
            .collect()
    }

    #[test]
    fn fts5_is_available() {
        // Guards the assumption that rusqlite's bundled SQLite ships FTS5.
        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
                 VALUES ('p1', 'hello world', '', '', '', '', 0)",
                [],
            )
            .unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM search_index WHERE search_index MATCH '{title} : (\"hello\")'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn segments_cjk_into_single_char_tokens() {
        assert_eq!(cjk_segment("机器学习"), "机 器 学 习");
        assert_eq!(cjk_segment("GPT模型"), "GPT 模 型");
        assert_eq!(cjk_segment("plain latin text"), "plain latin text");
        assert_eq!(cjk_segment("  spaced   out  "), "spaced out");
    }

    #[test]
    fn builds_sanitized_column_queries() {
        assert_eq!(
            build_fts_column_query("attention vaswani", "title"),
            Some(r#"{title} : ("attention" "vaswani"*)"#.to_string())
        );
        // FTS5 operators are neutralized by phrase quoting; embedded quotes stripped.
        assert_eq!(
            build_fts_column_query(r#"a OR b"c"#, "body"),
            Some(r#"{body} : ("a" "OR" "bc"*)"#.to_string())
        );
        // CJK terms become single-char phrases with no prefix star.
        assert_eq!(
            build_fts_column_query("机器学习", "notes"),
            Some(r#"{notes} : ("机 器 学 习")"#.to_string())
        );
        // Operator-only input yields no query at all.
        assert_eq!(build_fts_column_query("- * ( )", "title"), None);
        assert_eq!(build_fts_column_query("   ", "title"), None);
    }

    #[test]
    fn ranks_title_over_body_over_authors_over_notes() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p-title", &paper_json("p-title", "Quantum computing survey", &["Alice"]), None);
        upsert_entity(&connection, "paper", "p-body", &paper_json("p-body", "Fast inference", &["Bob"]), None);
        upsert_entity(&connection, "paper", "p-author", &paper_json("p-author", "Graph networks", &["John Quantum"]), None);
        upsert_entity(&connection, "paper", "p-note", &paper_json("p-note", "Sparse attention", &["Carol"]), None);
        index_paper_body(&connection, "p-body", "sha-b", "we study quantum entanglement at scale").unwrap();
        upsert_entity(
            &connection,
            "annotation",
            "a1",
            &annotation_json("a1", "p-note", "quantum supremacy claim", "check this"),
            None,
        );

        let hits = search_library_rows(&connection, "quantum", SEARCH_RESULT_LIMIT).unwrap();
        let ids: Vec<&str> = hits.iter().map(|hit| hit.paper_id.as_str()).collect();
        assert_eq!(ids, ["p-title", "p-body", "p-author", "p-note"]);
        assert_eq!(hits[0].tier, 1);
        assert_eq!(hits[0].matched_fields, ["title"]);
        assert_eq!(hits[1].matched_fields, ["body"]);
        assert_eq!(hits[2].matched_fields, ["authors"]);
        assert_eq!(hits[3].matched_fields, ["notes"]);
        assert!(hits[1].snippet.contains('\u{1}'), "snippet should carry highlight markers");
    }

    #[test]
    fn reports_all_matched_fields_at_best_tier() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p1", &paper_json("p1", "Diffusion models", &["Dana"]), None);
        index_paper_body(&connection, "p1", "sha", "diffusion in pixel space").unwrap();

        let hits = search_library_rows(&connection, "diffusion", SEARCH_RESULT_LIMIT).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tier, 1);
        assert_eq!(hits[0].matched_fields, ["title", "body"]);
    }

    #[test]
    fn matches_cjk_substrings_in_notes() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p1", &paper_json("p1", "Attention is all you need", &["Vaswani"]), None);
        upsert_entity(
            &connection,
            "annotation",
            "a1",
            &annotation_json("a1", "p1", "", "注意力机制的核心思想"),
            None,
        );

        assert_eq!(search_ids(&connection, "注意力"), ["p1"]);
        assert_eq!(search_ids(&connection, "机制"), ["p1"]);
        assert!(search_ids(&connection, "力注").is_empty(), "non-consecutive CJK chars must not match");
    }

    #[test]
    fn soft_delete_hides_paper_and_restore_keeps_body() {
        let connection = test_connection();
        let data = paper_json("p1", "Neural tangent kernels", &["Eve"]);
        upsert_entity(&connection, "paper", "p1", &data, None);
        index_paper_body(&connection, "p1", "sha", "tangent kernel dynamics").unwrap();
        assert_eq!(search_ids(&connection, "tangent"), ["p1"]);

        upsert_entity(&connection, "paper", "p1", &data, Some("2026-01-02T00:00:00Z"));
        assert!(search_ids(&connection, "tangent").is_empty());

        upsert_entity(&connection, "paper", "p1", &data, None);
        // Body survives the trash/restore round trip without re-extraction.
        assert_eq!(search_ids(&connection, "kernel dynamics"), ["p1"]);
    }

    #[test]
    fn annotation_soft_delete_reaggregates_notes() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p1", &paper_json("p1", "Some title", &[]), None);
        let annotation = annotation_json("a1", "p1", "wavelet transform trick", "");
        upsert_entity(&connection, "annotation", "a1", &annotation, None);
        assert_eq!(search_ids(&connection, "wavelet"), ["p1"]);

        upsert_entity(&connection, "annotation", "a1", &annotation, Some("2026-01-02T00:00:00Z"));
        assert!(search_ids(&connection, "wavelet").is_empty());
    }

    #[test]
    fn rebuilds_index_from_existing_entities() {
        // Simulates upgrading an existing library: entities exist, index does not.
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        init_library_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES ('paper', 'p1', ?1, '2026-01-01T00:00:00Z', NULL, 0)",
                [paper_json("p1", "Legacy 论文 title", &["Frank"])],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES ('annotation', 'a1', ?1, '2026-01-01T00:00:00Z', NULL, 0)",
                [annotation_json("a1", "p1", "老笔记", "legacy note")],
            )
            .unwrap();

        ensure_search_index(&connection).unwrap();
        assert_eq!(search_ids(&connection, "论文"), ["p1"]);
        assert_eq!(search_ids(&connection, "legacy"), ["p1"]);
        assert_eq!(search_ids(&connection, "老笔记"), ["p1"]);
    }
}
