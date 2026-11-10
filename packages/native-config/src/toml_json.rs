//! Pure (N-API-free) TOML parse + JSON projection used by the read/classify
//! path. Kept free of any `napi` types so it is directly unit-testable under a
//! plain `cargo test` binary; the thin `#[napi]` wrapper lives in `lib.rs`.

use serde_json::{Map, Number, Value as JsonValue};
use toml_edit::{Array, DocumentMut, InlineTable, Item, Table, Value as TomlValue};

/// Parse TOML text and project it to a compact JSON string.
///
/// Returns `Err(reason)` only for genuinely-unparseable input. A capable parser
/// (`toml_edit`) accepts 64-bit integers past the JS safe-integer boundary and
/// microsecond/offset datetimes that the JS `smol-toml` parser rejects, so a
/// valid harness config is never mis-flagged on the classify path. The error
/// reason is a fixed string — never an echo of the file's bytes.
///
/// The projection is intentionally lossy for *write* fidelity (JSON has no
/// integer/float distinction or datetime type); it feeds only the read/classify
/// path, which compares structural shape and our own entry's value. Format-
/// preserving writes use the document model directly, not this projection.
pub fn parse_toml_to_json(toml_text: &str) -> Result<String, String> {
    let doc = toml_text
        .parse::<DocumentMut>()
        .map_err(|_| "invalid TOML".to_string())?;
    let value = table_to_json(doc.as_table());
    serde_json::to_string(&value).map_err(|_| "serialize failed".to_string())
}

fn item_to_json(item: &Item) -> JsonValue {
    match item {
        Item::None => JsonValue::Null,
        Item::Value(value) => value_to_json(value),
        Item::Table(table) => table_to_json(table),
        Item::ArrayOfTables(array) => {
            JsonValue::Array(array.iter().map(table_to_json).collect())
        }
    }
}

fn table_to_json(table: &Table) -> JsonValue {
    let mut map = Map::new();
    for (key, item) in table.iter() {
        map.insert(key.to_string(), item_to_json(item));
    }
    JsonValue::Object(map)
}

fn inline_table_to_json(table: &InlineTable) -> JsonValue {
    let mut map = Map::new();
    for (key, value) in table.iter() {
        map.insert(key.to_string(), value_to_json(value));
    }
    JsonValue::Object(map)
}

fn array_to_json(array: &Array) -> JsonValue {
    JsonValue::Array(array.iter().map(value_to_json).collect())
}

fn value_to_json(value: &TomlValue) -> JsonValue {
    match value {
        TomlValue::String(s) => JsonValue::String(s.value().to_string()),
        TomlValue::Integer(i) => JsonValue::Number(Number::from(*i.value())),
        // A non-finite float has no JSON representation; project it as null
        // rather than fail the whole parse. Real configs never carry one.
        TomlValue::Float(f) => Number::from_f64(*f.value())
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        TomlValue::Boolean(b) => JsonValue::Bool(*b.value()),
        TomlValue::Datetime(dt) => JsonValue::String(dt.value().to_string()),
        TomlValue::Array(a) => array_to_json(a),
        TomlValue::InlineTable(t) => inline_table_to_json(t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_integers_past_the_js_safe_boundary() {
        // `9223372036854775807` (i64::MAX) and `9007199254740993` (2^53 + 1)
        // both exceed Number.MAX_SAFE_INTEGER; smol-toml throws on them, which
        // is the throw that mis-classified a valid config as corrupt.
        let toml = "big = 9223372036854775807\njust_over = 9007199254740993\n";
        let json = parse_toml_to_json(toml).expect("capable parser must accept i64");
        assert!(json.contains("9223372036854775807"));
        assert!(json.contains("9007199254740993"));
    }

    #[test]
    fn accepts_microsecond_datetime() {
        let toml = "ts = 2026-06-26T12:34:56.123456Z\n";
        let json = parse_toml_to_json(toml).expect("must accept microsecond datetime");
        assert!(json.contains("2026-06-26T12:34:56.123456Z"));
    }

    #[test]
    fn projects_nested_tables_and_arrays() {
        let toml = "[mcp_servers.open-knowledge]\ncommand = \"/bin/sh\"\nargs = [\"-l\", \"-c\"]\n";
        let json = parse_toml_to_json(toml).unwrap();
        let parsed: JsonValue = serde_json::from_str(&json).unwrap();
        let entry = &parsed["mcp_servers"]["open-knowledge"];
        assert_eq!(entry["command"], JsonValue::String("/bin/sh".into()));
        assert_eq!(entry["args"][0], JsonValue::String("-l".into()));
        assert_eq!(entry["args"][1], JsonValue::String("-c".into()));
    }

    #[test]
    fn projects_inline_table_entry() {
        let toml = "mcp_servers = { \"open-knowledge\" = { command = \"npx\" } }\n";
        let json = parse_toml_to_json(toml).unwrap();
        let parsed: JsonValue = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed["mcp_servers"]["open-knowledge"]["command"],
            JsonValue::String("npx".into())
        );
    }

    #[test]
    fn rejects_genuinely_malformed_toml() {
        let err = parse_toml_to_json("not = valid = toml = at = all").unwrap_err();
        assert_eq!(err, "invalid TOML");
    }

    #[test]
    fn empty_input_projects_to_empty_object() {
        assert_eq!(parse_toml_to_json("").unwrap(), "{}");
        assert_eq!(parse_toml_to_json("   \n\t\n").unwrap(), "{}");
    }
}
