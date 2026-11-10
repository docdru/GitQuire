//! Decor-preserving `toml_edit` table primitives, ported from Codex's
//! `core/src/config/edit/document_helpers.rs` (Apache-2.0). These are the
//! building blocks the insert-only upsert engine stands on: they migrate an
//! inline table to an explicit one *in place* without discarding the keys it
//! already holds, and they seed intermediate tables as implicit so a fresh
//! `[mcp_servers.<name>]` renders with the canonical implicit-parent header.
//!
//! Codex's bulk `replace_mcp_servers` (which prunes siblings and regenerates the
//! whole `[mcp_servers]` subtree) is deliberately NOT ported — the engine here
//! reconciles a single entry per key and never touches siblings.

use toml_edit::{InlineTable, Item, Table};

/// A table that exists only to host nested headers — its own `[header]` line is
/// suppressed on serialize unless it gains direct leaf children. Used for the
/// `mcp_servers` parent so a fresh entry renders as `[mcp_servers.<name>]`.
pub fn new_implicit_table() -> Table {
    let mut table = Table::new();
    table.set_implicit(true);
    table
}

/// Rebuild an inline table as a standard table, carrying each value across with
/// its decor but dropping the inline trailing-space suffix so the migrated keys
/// land on their own lines cleanly.
pub fn table_from_inline(inline: &InlineTable) -> Table {
    let mut table = new_implicit_table();
    for (key, value) in inline.iter() {
        let mut value = value.clone();
        value.decor_mut().set_suffix("");
        table.insert(key, Item::Value(value));
    }
    table
}

/// Resolve `item` to a mutable standard table, migrating an inline table or a
/// bare value in place. Returns `None` only for items that cannot host keys
/// (e.g. an array of tables), which the caller treats as "leave untouched".
pub fn ensure_table_for_write(item: &mut Item) -> Option<&mut Table> {
    match item {
        Item::Table(_) => {}
        Item::Value(value) => {
            let replacement = if let Some(inline) = value.as_inline_table() {
                table_from_inline(inline)
            } else {
                new_implicit_table()
            };
            *item = Item::Table(replacement);
        }
        Item::None => {
            *item = Item::Table(new_implicit_table());
        }
        _ => return None,
    }
    item.as_table_mut()
}

/// Copy the formatting (whitespace + comments) of an existing node onto its
/// replacement so an only-additive edit preserves the user's surrounding decor.
/// Recurses into tables key-by-key, matching Codex's `preserve_decor`.
pub fn preserve_decor(existing: &Item, replacement: &mut Item) {
    match (existing, replacement) {
        (Item::Table(existing_table), Item::Table(replacement_table)) => {
            replacement_table
                .decor_mut()
                .clone_from(existing_table.decor());
            for (key, existing_item) in existing_table.iter() {
                if let (Some(existing_key), Some(mut replacement_key)) =
                    (existing_table.key(key), replacement_table.key_mut(key))
                {
                    replacement_key
                        .leaf_decor_mut()
                        .clone_from(existing_key.leaf_decor());
                    replacement_key
                        .dotted_decor_mut()
                        .clone_from(existing_key.dotted_decor());
                }
                if let Some(replacement_item) = replacement_table.get_mut(key) {
                    preserve_decor(existing_item, replacement_item);
                }
            }
        }
        (Item::Value(existing_value), Item::Value(replacement_value)) => {
            replacement_value
                .decor_mut()
                .clone_from(existing_value.decor());
        }
        _ => {}
    }
}
