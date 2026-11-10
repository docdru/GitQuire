//! Conformance suite ported from Codex's `core/src/config/edit_tests.rs`
//! (Apache-2.0). Codex's own edit tests are OpenKnowledge's invariant floor:
//! the TOML-generic cases (comment/decor preservation, implicit-parent
//! rendering, auto-quoting, int-vs-float and large-integer fidelity, no-op and
//! byte-stability) are the "cases we are not thinking about." Codex's
//! schema-specific cases are re-expressed against OpenKnowledge's single
//! `[mcp_servers.open-knowledge]` entry (register / deregister / prune-only-our
//! -keys) rather than copied verbatim, since OpenKnowledge inserts one entry
//! instead of regenerating the whole table.
//!
//! BOM and CRLF are deliberately NOT asserted here: `toml_edit` strips a leading
//! BOM and normalizes CRLF to LF on serialize, so byte-level encoding fidelity
//! is the wrapper's job on the JS write spine, not this document engine's.

use super::*;
use toml_edit::DocumentMut;

const PUBLISHED_ENTRY: &str = r#"{"command":"/bin/sh","args":["-l","-c","run-ok"]}"#;

fn parse(text: &str) -> DocumentMut {
    text.parse::<DocumentMut>()
        .expect("engine output must be valid TOML")
}

fn upsert(text: &str, entry: &str) -> UpsertOutcome {
    upsert_mcp_server(text, "open-knowledge", entry).expect("upsert must succeed")
}

// ─── TOML-generic invariants ─────────────────────────────────────────────────

#[test]
fn fresh_insert_renders_implicit_parent_header_not_bare_table() {
    let out = upsert("", PUBLISHED_ENTRY);
    assert!(out.text.contains("[mcp_servers.open-knowledge]"));
    // The parent must stay implicit — a bare `[mcp_servers]` header would be a
    // spurious empty table we never asked for.
    assert!(!out.text.contains("[mcp_servers]"));
}

#[test]
fn auto_quotes_server_name_that_is_not_a_bare_key() {
    let out = upsert_mcp_server("", "weird.name", PUBLISHED_ENTRY).expect("upsert");
    assert!(out.text.contains("[mcp_servers.\"weird.name\"]"));
    let doc = parse(&out.text);
    assert_eq!(
        doc["mcp_servers"]["weird.name"]["command"].as_str(),
        Some("/bin/sh")
    );
}

#[test]
fn preserves_sibling_large_integer_through_a_write() {
    // smol-toml throws on this i64 (the throw that mis-classified a real config
    // as corrupt); toml_edit preserves it byte-for-byte across an only-additive
    // write.
    let input = "big = 9223372036854775807\n";
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.text.starts_with("big = 9223372036854775807\n"));
    assert!(out.changed);
}

#[test]
fn preserves_sibling_microsecond_datetime_through_a_write() {
    let input = "ts = 2026-06-26T12:34:56.123456Z\n";
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.text.starts_with("ts = 2026-06-26T12:34:56.123456Z\n"));
}

#[test]
fn preserves_sibling_integer_valued_float_through_a_write() {
    let input = "timeout = 30.0\n";
    let out = upsert(input, PUBLISHED_ENTRY);
    // 30.0 must not retype to 30.
    assert!(out.text.contains("timeout = 30.0"));
}

#[test]
fn preserves_inline_sibling_and_its_comment_on_register() {
    let input = "[mcp_servers]\n# keep me\nother = { command = \"cmd\" }\n";
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.changed);
    assert!(out.text.contains("# keep me"));
    assert!(out.text.contains("other = { command = \"cmd\" }"));
    assert!(out.text.contains("[mcp_servers.open-knowledge]"));
    let doc = parse(&out.text);
    assert_eq!(doc["mcp_servers"]["other"]["command"].as_str(), Some("cmd"));
}

#[test]
fn round_trips_a_to_b_to_a_byte_stably() {
    let v1 = r#"{"command":"/bin/sh","args":["-l","-c","ONE"]}"#;
    let v2 = r#"{"command":"/bin/sh","args":["-l","-c","TWO"]}"#;
    let first = upsert("approval_policy = \"never\"\n", v1).text;
    let second = upsert(&first, v2);
    assert!(second.changed);
    let third = upsert(&second.text, v1);
    assert!(third.changed);
    assert_eq!(third.text, first);
}

#[test]
fn removing_only_entry_keeps_an_explicit_mcp_servers_table() {
    // Unlike Codex's clears-empty-table behavior, OpenKnowledge owns only its
    // own entry, never the surrounding table, so an explicit `[mcp_servers]`
    // survives even after the last managed server is removed.
    let input = "[mcp_servers]\nopen-knowledge = { command = \"x\" }\n";
    let out = remove_mcp_server(input, "open-knowledge").expect("remove");
    assert!(out.changed);
    assert!(out.text.contains("[mcp_servers]"));
    assert!(!out.text.contains("open-knowledge"));
}

#[test]
fn remove_on_a_config_without_the_table_is_a_noop_and_creates_nothing() {
    let input = "model = \"gpt-5\"\n";
    let out = remove_mcp_server(input, "open-knowledge").expect("remove");
    assert!(!out.changed);
    assert_eq!(out.text, input);
    assert!(!out.text.contains("mcp_servers"));
}

#[test]
fn single_element_args_array_stays_an_array() {
    let out = upsert("", r#"{"command":"x","args":["only"]}"#);
    let doc = parse(&out.text);
    let args = doc["mcp_servers"]["open-knowledge"]["args"]
        .as_array()
        .expect("args must serialize as an array");
    assert_eq!(args.len(), 1);
    assert_eq!(args.get(0).and_then(|v| v.as_str()), Some("only"));
}

#[test]
fn preserves_a_dotted_root_key_on_register() {
    let input = "server.host = \"localhost\"\n";
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.text.starts_with("server.host = \"localhost\"\n"));
}

// ─── OpenKnowledge-schema register / deregister / prune ──────────────────────

#[test]
fn registers_the_published_chain_shape_round_tripping_a_multiline_arg() {
    // The real published entry's third arg is a multi-line resolver script; it
    // must survive the document round-trip with its content intact.
    let chain = "# ok-mcp-v1\nexec npx -y @inkeep/open-knowledge@latest mcp";
    let entry = serde_json::json!({
        "command": "/bin/sh",
        "args": ["-l", "-c", chain],
    })
    .to_string();
    let out = upsert("", &entry);
    let doc = parse(&out.text);
    let server = &doc["mcp_servers"]["open-knowledge"];
    assert_eq!(server["command"].as_str(), Some("/bin/sh"));
    assert_eq!(server["args"][0].as_str(), Some("-l"));
    let body = server["args"][2].as_str().expect("third arg is a string");
    assert!(body.contains("# ok-mcp-v1"));
    assert!(body.contains("@inkeep/open-knowledge@latest mcp"));
}

#[test]
fn registers_into_an_existing_config_preserving_root_keys() {
    let input = "model = \"gpt-5\"\napproval_policy = \"never\"\n";
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.text.starts_with("model = \"gpt-5\"\napproval_policy = \"never\"\n"));
    assert!(out.text.contains("[mcp_servers.open-knowledge]"));
}

#[test]
fn registers_alongside_a_sibling_server_and_its_comments() {
    let input = r#"[mcp_servers.linear]
name = "linear"
# keep this note
url = "https://linear.example"
"#;
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.text.contains("[mcp_servers.linear]"));
    assert!(out.text.contains("# keep this note"));
    assert!(out.text.contains("url = \"https://linear.example\""));
    assert!(out.text.contains("[mcp_servers.open-knowledge]"));
}

#[test]
fn registers_an_entry_carrying_an_env_subtable() {
    let entry = r#"{"command":"node","args":["mcp"],"env":{"OK_TOKEN":"abc"}}"#;
    let out = upsert("", entry);
    let doc = parse(&out.text);
    assert_eq!(
        doc["mcp_servers"]["open-knowledge"]["env"]["OK_TOKEN"].as_str(),
        Some("abc")
    );
}

#[test]
fn update_reconciles_managed_keys_but_never_prunes_hand_added_keys() {
    let input = r#"[mcp_servers.open-knowledge]
command = "/bin/sh"
args = ["-l", "-c", "OLD"]
enabled = false
"#;
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.changed);
    assert!(out.text.contains("run-ok"));
    assert!(!out.text.contains("OLD"));
    // A key the user added to our own entry is theirs to keep.
    assert!(out.text.contains("enabled = false"));
}

#[test]
fn deregisters_keeping_table_siblings_and_their_comments() {
    let input = r#"[mcp_servers.other]
command = "other-cmd"  # sibling note

[mcp_servers.open-knowledge]
command = "/bin/sh"
args = ["-l", "-c", "run-ok"]
"#;
    let out = remove_mcp_server(input, "open-knowledge").expect("remove");
    assert!(out.changed);
    assert!(!out.text.contains("[mcp_servers.open-knowledge]"));
    assert!(out.text.contains("[mcp_servers.other]"));
    assert!(out.text.contains("command = \"other-cmd\"  # sibling note"));
}

#[test]
fn register_does_not_disturb_an_unrelated_profile_table() {
    let input = r#"profile = "team"

[profiles.team]
model = "gpt-5"
sandbox_mode = "strict"
"#;
    let out = upsert(input, PUBLISHED_ENTRY);
    assert!(out.text.contains("[profiles.team]"));
    assert!(out.text.contains("sandbox_mode = \"strict\""));
    let doc = parse(&out.text);
    assert_eq!(
        doc["profiles"]["team"]["model"].as_str(),
        Some("gpt-5"),
        "an unrelated profile table must be untouched"
    );
}
