//! Bounded projections of optional Pi controls; malformed capabilities stay unavailable.
use crate::protocol::{ModelOption, ThinkingLevel};
use serde_json::Value;

/// Model identities are nonempty, control-free UTF-8 strings of at most 256 bytes.
pub(super) fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// Projects one full RPC model without retaining private configuration.
pub(super) fn model(value: &Value) -> Option<ModelOption> {
    let id = value["id"].as_str().filter(|s| identity(s))?;
    let provider = value["provider"].as_str().filter(|s| identity(s))?;
    let name = value["name"].as_str().filter(|s| identity(s))?;
    Some(ModelOption {
        id: id.into(),
        provider: provider.into(),
        name: name.into(),
        images: value["input"].as_array().is_some_and(|input| input.iter().any(|kind| kind == "image")),
    })
}

/// Rejects catalogs above 512 models or 64 KiB of projected JSON instead of truncating.
/// The serialized budget includes escaping and leaves room in the browser frame for state.
pub(super) fn models(value: &Value) -> Vec<ModelOption> {
    value["models"]
        .as_array()
        .filter(|v| v.len() <= 512)
        .and_then(|v| v.iter().map(model).collect::<Option<Vec<_>>>())
        .filter(|models| {
            serde_json::to_vec(models)
                .expect("model projection serialization")
                .len()
                <= 64 * 1024
        })
        .unwrap_or_default()
}

/// Retains only unique advertised enum levels; invalid responses disable the selector.
pub(super) fn levels(value: &Value) -> Vec<ThinkingLevel> {
    let Some(values) = value["levels"].as_array().filter(|v| v.len() <= 7) else {
        return vec![];
    };
    let mut levels = Vec::new();
    for value in values {
        let Ok(level) = serde_json::from_value::<ThinkingLevel>(value.clone()) else {
            return vec![];
        };
        if !levels.contains(&level) {
            levels.push(level);
        }
    }
    levels
}

/// Projects token estimates without treating unavailable usage as zero. Values fit JS integers.
pub(super) fn context_usage(value: &Value) -> Option<crate::protocol::ContextUsage> {
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    let context_window = value["contextWindow"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= MAX_SAFE)?;
    let tokens = match value.get("tokens")? {
        Value::Null => None,
        value => Some(value.as_u64().filter(|n| *n <= MAX_SAFE)?),
    };
    Some(crate::protocol::ContextUsage {
        tokens,
        context_window,
    })
}

/// Projects LSP footer text, removing theme CSI escapes and controls, capped at 512 UTF-8 bytes.
/// Missing, non-string, and empty values clear the extension's status.
pub(super) fn lsp_status(value: &Value) -> Option<String> {
    let mut chars = value.as_str()?.chars().peekable();
    let mut text = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        } else if !ch.is_control() {
            if text.len() + ch.len_utf8() > 512 {
                break;
            }
            text.push(ch);
        }
    }
    (!text.trim().is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lsp_status_removes_theme_escapes_and_bounds_utf8() {
        assert_eq!(
            lsp_status(&json!("\u{1b}[38;2;1;2;3mLSP: 1/2 servers\u{1b}[39m\n")),
            Some("LSP: 1/2 servers".into())
        );
        assert_eq!(lsp_status(&json!("é".repeat(300))), Some("é".repeat(256)));
        for value in [Value::Null, json!(false), json!(""), json!("\u{1b}[0m\n")] {
            assert_eq!(lsp_status(&value), None);
        }
    }

    #[test]
    fn context_usage_preserves_unknown_and_zero_and_rejects_invalid_numbers() {
        assert_eq!(
            context_usage(&json!({"tokens": 12500, "contextWindow": 100000}))
                .unwrap()
                .tokens,
            Some(12500)
        );
        assert_eq!(
            context_usage(&json!({"tokens": 0, "contextWindow": 100000}))
                .unwrap()
                .tokens,
            Some(0)
        );
        assert_eq!(
            context_usage(&json!({"tokens": null, "contextWindow": 100000}))
                .unwrap()
                .tokens,
            None
        );
        for invalid in [
            Value::Null,
            json!({"tokens": 1, "contextWindow": 0}),
            json!({"tokens": -1, "contextWindow": 100}),
            json!({"tokens": 1.5, "contextWindow": 100}),
            json!({"contextWindow": 100}),
            json!({"tokens": 9007199254740992_u64, "contextWindow": 100}),
        ] {
            assert!(context_usage(&invalid).is_none());
        }
    }

    #[test]
    fn model_projection_enforces_utf8_bounds_and_removes_private_fields() {
        let value = json!({"id":"model", "provider":"provider", "name":"Name", "baseURL":"private", "cost":{"input": 42}});
        assert_eq!(
            serde_json::to_value(model(&value).unwrap()).unwrap(),
            json!({"id":"model", "provider":"provider", "name":"Name", "images":false})
        );
        let mut image_model = value.clone();
        image_model["input"] = json!(["text", "image"]);
        assert!(model(&image_model).unwrap().images);
        for field in ["id", "provider", "name"] {
            for invalid in [String::new(), "\ncontrol".into(), "é".repeat(129)] {
                let mut invalid_model = value.clone();
                invalid_model[field] = json!(invalid);
                assert!(model(&invalid_model).is_none());
            }
            let mut boundary = value.clone();
            boundary[field] = json!("é".repeat(128));
            assert!(model(&boundary).is_some());
        }
        assert_eq!(
            models(&json!({"models": vec![value.clone(); 512]})).len(),
            512
        );
        assert!(models(&json!({"models": vec![value; 513]})).is_empty());
    }

    #[test]
    fn catalog_budget_accounts_for_projected_json_and_escaping() {
        let long =
            json!({"id": "a".repeat(256), "provider": "b".repeat(256), "name": "c".repeat(256)});
        assert!(models(&json!({"models": vec![long; 100]})).is_empty());
        let escaped =
            json!({"id": "\"".repeat(256), "provider": "\\".repeat(256), "name": "\"".repeat(256)});
        assert!(models(&json!({"models": vec![escaped; 50]})).is_empty());
    }

    #[test]
    fn levels_use_only_unique_advertised_values() {
        assert_eq!(
            levels(&json!({"levels": ["high", "off", "high"]})),
            vec![ThinkingLevel::High, ThinkingLevel::Off]
        );
        assert!(levels(&json!({"levels": ["unknown"]})).is_empty());
        assert!(levels(&json!({"levels": vec!["off"; 8]})).is_empty());
        assert!(levels(&Value::Null).is_empty());
    }
}
