//! Persisted and live projection share only opaque refs, never model payloads.
use base64::{Engine, engine::general_purpose::STANDARD};
use pi_web::{history, images::Images, rpc::RpcCommand, view::normalize_message};
use serde_json::json;
use std::io::Cursor;
fn png() -> Vec<u8> { STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap() }
#[test]
fn image_only_and_mixed_rpc_stay_under_transport_budget() {
    let images = Images::default(); let id = images.upload(png()).unwrap();
    for text in ["", "describe this"] {
        let command = RpcCommand::Prompt { message: text.into(), images: images.prompt(&[id.clone()]).unwrap() };
        let value = serde_json::to_value(command).unwrap();
        assert_eq!(value["message"], text);
        assert_eq!(value["images"][0], json!({"type":"image","data":STANDARD.encode(png()),"mimeType":"image/png"}));
        assert!(value.to_string().len() < 1024*1024);
    }
}
#[test]
fn reload_reconstructs_large_tool_images_without_base64_or_metadata_in_preview() {
    let mut bytes = png(); let end = bytes.split_off(bytes.len()-12); bytes.extend(vec![0; 100_000]); bytes.extend(end);
    // Header validation intentionally does not assert full PNG decoder validity.
    let data = STANDARD.encode(&bytes);
    let message = json!({"role":"toolResult","toolName":"private","errorMessage":"private","content":[{"type":"text","text":"private"},{"type":"image","data":data,"mimeType":"image/png"}]});
    let file = format!("{}\n{}\n", json!({"type":"session","version":3}), json!({"id":"leaf","parentId":null,"type":"message","message":message}));
    for _ in 0..2 {
        let cache = Images::default();
        let history = history::project_images(Cursor::new(&file), "leaf", |entry| cache.project_message(&mut entry["message"])).unwrap();
        let preview = normalize_message("leaf".into(), &history.entries[0]["message"], true).unwrap();
        let snapshot = serde_json::to_string(&preview).unwrap();
        assert!(!snapshot.contains("private")); assert!(!snapshot.contains(&data)); assert!(snapshot.len() < 512);
        assert_eq!(cache.get(&preview.blocks[0].text).unwrap().bytes.as_ref(), &bytes);
        let mut live = message.clone(); cache.project_message(&mut live);
        assert_eq!(normalize_message("leaf".into(), &live, true).unwrap(), preview);
    }
}
#[test]
fn dense_image_records_hit_node_budget_before_projection() {
    let file = format!("{}\n{}\n", json!({"type":"session","version":3}), json!({"id":"leaf","type":"message","message":{"role":"user","content":"kept"}, "dense":vec![0;100_000]}));
    let projected = history::project_images(Cursor::new(file), "leaf", |entry| assert!(entry["dense"].is_null())).unwrap();
    assert_eq!(projected.entries[0]["truncated"], true);
}
