//! Bounded, privacy-preserving projection of Pi's startup command catalog.
use crate::protocol::{SlashCommand, SlashCommandSource};
use serde_json::Value;
use std::collections::HashSet;

/// Keeps the first valid command per name in Pi priority order, up to 512 entries.
/// Names are nonempty tokens of at most 256 UTF-8 bytes without a leading slash;
/// descriptions are optional text clipped at a UTF-8 boundary to 1024 bytes.
pub(super) fn project(data: &Value) -> Vec<SlashCommand> {
    let Some(records) = data["commands"].as_array() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    records
        .iter()
        .filter_map(|record| {
            let name = record["name"].as_str()?;
            if name.is_empty()
                || name.len() > 256
                || name.starts_with('/')
                || name.chars().any(|c| c.is_whitespace() || c.is_control())
                || name == "pi-web-history-head"
            {
                return None;
            }
            let source = match record["source"].as_str()? {
                "extension" => SlashCommandSource::Extension,
                "prompt" => SlashCommandSource::Prompt,
                "skill" => SlashCommandSource::Skill,
                _ => return None,
            };
            if !seen.insert(name) {
                return None;
            }
            Some(SlashCommand {
                name: name.to_owned(),
                description: record["description"]
                    .as_str()
                    .map(|text| super::clip(text, 1024)),
                source,
            })
        })
        .take(512)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projection_rejects_malformed_names_sources_and_private_metadata() {
        let data = json!({"commands": [
            null, {}, {"name": 42, "source": "skill"},
            {"name": "", "source": "skill"},
            {"name": "/bad", "source": "skill"},
            {"name": "two words", "source": "skill"},
            {"name": "line\nfeed", "source": "skill"},
            {"name": "nul\u{0000}", "source": "skill"},
            {"name": "wide\u{2003}space", "source": "skill"},
            {"name": "pi-web-history-head", "source": "extension"},
            {"name": "unknown", "source": "future"},
            {"name": "missing"}, {"name": "object", "source": {}},
            {"name": "valid", "source": "invalid"},
            {"name": "valid", "source": "extension", "description": "first", "sourceInfo": {"path": "/private/path"}},
            {"name": "valid", "source": "prompt", "description": "duplicate"},
            {"name": "skill:review", "source": "skill", "description": {}},
            {"name": "template", "source": "prompt"}
        ]});
        assert_eq!(
            serde_json::to_value(project(&data)).unwrap(),
            json!([
                {"name": "valid", "source": "extension", "description": "first"},
                {"name": "skill:review", "source": "skill", "description": null},
                {"name": "template", "source": "prompt", "description": null}
            ])
        );
        assert!(project(&json!({"commands": {}})).is_empty());
    }

    #[test]
    fn projection_bounds_utf8_bytes_and_unique_entry_count() {
        let boundary = "é".repeat(128);
        let data = json!({"commands": [
            {"name": format!("{boundary}a"), "source": "skill"},
            {"name": boundary, "source": "skill", "description": format!("{}é", "a".repeat(1023))},
            {"name": "exact", "source": "prompt", "description": "é".repeat(512)}
        ]});
        let commands = project(&data);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, boundary);
        assert_eq!(commands[0].description, Some("a".repeat(1023)));
        assert_eq!(commands[1].description, Some("é".repeat(512)));
        let mut records = vec![json!({"name": "duplicate", "source": "prompt"}); 600];
        records.extend((0..600).map(|i| json!({"name": format!("cmd-{i}"), "source": "skill"})));
        let commands = project(&json!({"commands": records}));
        assert_eq!(commands.len(), 512);
        assert_eq!(commands[0].name, "duplicate");
        assert_eq!(commands[511].name, "cmd-510");
    }
}
