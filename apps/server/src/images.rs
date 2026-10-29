//! Session-owned, bounded image cache. Pi JSONL remains authoritative: history
//! projection reconstructs this cache on reload; eviction yields an explicit unavailable
//! preview. No filesystem paths or model image payloads cross the browser protocol.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::{Arc, Mutex}, time::{Duration, Instant}};

pub const MAX_UPLOAD_BYTES: usize = 512 * 1024;
pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_IMAGES: usize = 4;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_COUNT: usize = 128;

#[derive(Clone)]
pub struct Image { pub bytes: Arc<Vec<u8>>, pub mime: &'static str }
struct Entry { id: String, image: Image, uploaded: Option<Instant>, display: bool }
#[derive(Default)]
struct Cache { entries: VecDeque<Entry>, bytes: usize }
/// Clones share one runtime-scoped cache; dropping the runtime releases its assets.
#[derive(Clone, Default)]
pub struct Images(Arc<Mutex<Cache>>);

pub fn valid_ref(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Checks PNG/JPEG signatures and declared dimensions, not full decoder validity.
/// Maximum 4096 per edge and 16 million pixels also bounds browser decode work.
pub fn inspect(bytes: &[u8]) -> Result<&'static str, &'static str> {
    if bytes.len() > MAX_IMAGE_BYTES { return Err("image_too_large"); }
    let (mime, width, height) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.len() < 45 || bytes.get(8..16) != Some(b"\0\0\0\rIHDR") || !bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82") { return Err("invalid_image"); }
        ("image/png", u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap()))
    } else if bytes.starts_with(&[0xff, 0xd8]) && bytes.ends_with(&[0xff, 0xd9]) {
        let mut offset = 2;
        let mut dimensions = None;
        while offset + 4 <= bytes.len() {
            if bytes[offset] != 0xff { return Err("invalid_image"); }
            while bytes.get(offset) == Some(&0xff) { offset += 1; }
            let marker = *bytes.get(offset).ok_or("invalid_image")?;
            offset += 1;
            if marker == 0xda || marker == 0xd9 { break; }
            if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
            let length = bytes.get(offset..offset + 2).ok_or("invalid_image")?;
            let length = u16::from_be_bytes([length[0], length[1]]) as usize;
            if length < 2 || offset + length > bytes.len() { return Err("invalid_image"); }
            if matches!(marker, 0xc0 | 0xc1 | 0xc2) {
                if length < 8 { return Err("invalid_image"); }
                dimensions = Some((u16::from_be_bytes([bytes[offset+5], bytes[offset+6]]) as u32, u16::from_be_bytes([bytes[offset+3], bytes[offset+4]]) as u32));
                break;
            }
            offset += length;
        }
        let (width, height) = dimensions.ok_or("invalid_image")?;
        ("image/jpeg", width, height)
    } else { return Err("unsupported_image"); };
    if width == 0 || height == 0 || width > 4096 || height > 4096 || u64::from(width) * u64::from(height) > 16_000_000 { return Err("image_dimensions"); }
    Ok(mime)
}

impl Images {
    /// Uploads expire after 30 minutes. Admission never consumes a reference, so
    /// rejected/uncertain sends preserve the draft without automatic replay.
    pub fn upload(&self, bytes: Vec<u8>) -> Result<String, &'static str> {
        if bytes.len() > MAX_UPLOAD_BYTES { return Err("image_too_large"); }
        self.insert(bytes, true)
    }
    fn insert(&self, bytes: Vec<u8>, upload: bool) -> Result<String, &'static str> {
        let mime = inspect(&bytes)?;
        let mut cache = self.0.lock().unwrap();
        if !upload && let Some(entry) = cache.entries.iter_mut().find(|entry| entry.image.bytes.as_slice() == bytes) { entry.display = true; return Ok(entry.id.clone()); }
        let id = crate::config::capability().map_err(|_| "image_unavailable")?;
        while cache.entries.len() >= CACHE_COUNT || cache.bytes + bytes.len() > CACHE_BYTES {
            let entry = cache.entries.pop_front().unwrap(); cache.bytes -= entry.image.bytes.len();
        }
        cache.bytes += bytes.len();
        cache.entries.push_back(Entry { id: id.clone(), image: Image { bytes: Arc::new(bytes), mime }, uploaded: upload.then(Instant::now), display: !upload });
        Ok(id)
    }
    pub fn get(&self, id: &str) -> Option<Image> {
        if !valid_ref(id) { return None; }
        let cache = self.0.lock().unwrap();
        cache.entries.iter().find(|entry| entry.id == id && (entry.display || entry.uploaded.is_some_and(|time| time.elapsed() < Duration::from_secs(1800)))).map(|entry| entry.image.clone())
    }
    /// Resolves only this session's uploaded references within the existing 1 MiB
    /// RPC write budget (512 KiB raw total, four images, plus 32 KiB prompt text).
    pub fn prompt(&self, ids: &[String]) -> Result<Vec<Value>, &'static str> {
        if ids.len() > MAX_IMAGES { return Err("too_many_images"); }
        let mut total = 0;
        let mut result = Vec::new();
        for id in ids {
            let image = {
                let cache = self.0.lock().unwrap();
                cache.entries.iter().find(|entry| entry.id == *id && entry.uploaded.is_some_and(|time| time.elapsed() < Duration::from_secs(1800)))
                    .map(|entry| entry.image.clone()).ok_or("image_unavailable")?
            };
            total += image.bytes.len();
            if total > MAX_UPLOAD_BYTES { return Err("images_too_large"); }
            result.push(json!({"type":"image", "data":STANDARD.encode(image.bytes.as_slice()), "mimeType":image.mime}));
        }
        Ok(result)
    }
    /// Replaces raw image blocks in a presentation-only copy with opaque refs.
    /// At most four images per message are decoded; unsupported images stay notices.
    pub fn project_message(&self, message: &mut Value) {
        if message["role"] == "system" || message["display"] == false || message["customType"] == "subagent-notification" { return; }
        let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) else { return; };
        let mut count = 0;
        for block in blocks {
            if block["type"] != "image" { continue; }
            count += 1;
            let id = if count <= MAX_IMAGES {
                block["data"].as_str().filter(|data| data.len() <= MAX_IMAGE_BYTES.div_ceil(3) * 4)
                    .and_then(|data| STANDARD.decode(data).ok()).and_then(|bytes| self.insert(bytes, false).ok())
            } else { None };
            *block = match id { Some(id) => json!({"type":"image_ref", "ref":id}), None => json!({"type":"image_unavailable"}) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> { STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap() }
    #[test]
    fn uploads_are_scoped_and_budgeted() {
        let a = Images::default(); let b = Images::default();
        let id = a.upload(png()).unwrap(); assert!(valid_ref(&id));
        assert!(b.get(&id).is_none()); assert!(b.prompt(&[id.clone()]).is_err());
        assert_eq!(a.prompt(&[id.clone()]).unwrap()[0]["mimeType"], "image/png");
        assert!(a.prompt(&vec![id; 5]).is_err());
        assert!(a.upload(vec![0; MAX_UPLOAD_BYTES + 1]).is_err());
        assert!(a.upload(b"<svg/>".to_vec()).is_err());
        let mut oversized = png(); oversized[16..20].copy_from_slice(&4097u32.to_be_bytes());
        assert_eq!(inspect(&oversized), Err("image_dimensions"));
    }
    #[test]
    fn projection_retains_only_references_and_reuses_content() {
        let images = Images::default();
        let mut message = json!({"role":"toolResult", "content":[{"type":"image", "data":STANDARD.encode(png()), "mimeType":"image/png"}]});
        let mut second = message.clone(); images.project_message(&mut message); images.project_message(&mut second);
        assert_eq!(message, second); assert!(message["content"][0]["data"].is_null());
        assert!(images.get(message["content"][0]["ref"].as_str().unwrap()).is_some());
    }
}

#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn count_eviction_expiry_and_promotion_are_explicit() {
        let images = Images::default();
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap();
        let expired = images.upload(bytes.clone()).unwrap();
        images.0.lock().unwrap().entries[0].uploaded = Some(Instant::now() - Duration::from_secs(1801));
        assert!(images.get(&expired).is_none()); assert!(images.prompt(&[expired.clone()]).is_err());
        assert_eq!(images.insert(bytes.clone(), false).unwrap(), expired);
        assert!(images.get(&expired).is_some()); assert!(images.prompt(&[expired.clone()]).is_err());
        for _ in 0..CACHE_COUNT { images.upload(bytes.clone()).unwrap(); }
        assert!(images.get(&expired).is_none());
        assert_eq!(images.0.lock().unwrap().entries.len(), CACHE_COUNT);
    }
    #[test]
    fn malformed_headers_and_combined_upload_budget_are_rejected() {
        assert!(inspect(&[0xff,0xd8,0xff,0xc0,0,255,0xff,0xd9]).is_err());
        assert!(inspect(b"\x89PNG\r\n\x1a\n").is_err());
        let images = Images::default();
        let mut bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap();
        let end = bytes.split_off(bytes.len()-12); bytes.resize(MAX_UPLOAD_BYTES, 0); bytes.extend(end);
        assert_eq!(images.upload(bytes.clone()), Err("image_too_large"));
        bytes.drain(24..40); let id = images.upload(bytes).unwrap();
        assert_eq!(images.prompt(&[id.clone(),id]).unwrap_err(), "images_too_large");
    }
}
