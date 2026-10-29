//! Bounded JSON metadata projection for session history.

use super::{MessageMetadata, Metadata, Result};
use std::io::BufRead;

/// Maximum decoded UTF-8 bytes in a captured key or metadata string.
/// Larger keys and inactive IDs are validated and discarded, never truncated.
pub(super) const MAX_METADATA_BYTES: usize = 1024;
const MAX_DEPTH: usize = 64;

/// Validates one complete JSON object and returns metadata only for `wanted_id`.
/// Captures at most 1024 decoded UTF-8 bytes per key/id/type/parent/role and allows
/// at most 64 nested containers (including the root). Ignored tokens are streamed.
/// Oversized selected metadata, duplicate metadata fields, invalid JSON/UTF-8,
/// missing type/message role, and I/O failures are errors. Missing/null parents
/// terminate ancestry. An oversized ID cannot match the bounded wanted ID.
pub(super) fn read_metadata(reader: impl BufRead, wanted_id: &str) -> Result<Option<Metadata>> {
    if wanted_id.len() > MAX_METADATA_BYTES {
        return Err("history leaf exceeds metadata limit".into());
    }
    let mut scanner = Scanner { reader };
    scanner.expect(b'{')?;
    let mut seen = 0u8;
    let mut kind = Field::Missing;
    let mut id = Field::Missing;
    let mut parent = Field::Missing;
    let mut role = Field::Missing;
    let mut message = false;
    let mut display = None;
    let mut internal_notification = false;
    if !scanner.consume(b'}')? {
        loop {
            let key = scanner.string(true)?;
            scanner.expect(b':')?;
            let bit = match key.as_deref() {
                Some("type") => 1,
                Some("id") => 2,
                Some("parentId") => 4,
                Some("message") => 8,
                Some("display") => 16,
                Some("customType") => 32,
                _ => 0,
            };
            if seen & bit != 0 {
                return Err("duplicate history metadata field".into());
            }
            seen |= bit;
            match bit {
                1 => kind = scanner.field(false)?,
                2 => id = scanner.field(true)?,
                4 => parent = scanner.field(true)?,
                8 => {
                    if scanner.peek_nonspace()? == Some(b'n') {
                        scanner.literal(b"null")?;
                    } else {
                        role = scanner.message()?;
                        message = true;
                    }
                }
                16 => {
                    display = match scanner.peek_nonspace()? {
                        Some(b'n') => {
                            scanner.literal(b"null")?;
                            None
                        }
                        Some(b't') => {
                            scanner.literal(b"true")?;
                            Some(true)
                        }
                        Some(b'f') => {
                            scanner.literal(b"false")?;
                            Some(false)
                        }
                        _ => return Err("invalid history display".into()),
                    };
                }
                32 => {
                    // Inspect the tag before oversized records become generic placeholders.
                    // Capture stays bounded; unrelated extension metadata is still ignored.
                    if scanner.peek_nonspace()? == Some(b'"') {
                        internal_notification =
                            scanner.string(true)?.as_deref() == Some("subagent-notification");
                    } else {
                        scanner.value(1)?;
                    }
                }
                _ => scanner.value(1)?,
            }
            if scanner.consume(b'}')? {
                break;
            }
            scanner.expect(b',')?;
        }
    }
    if scanner.peek_nonspace()?.is_some() {
        return Err("trailing JSON input".into());
    }
    if matches!(kind, Field::Missing) {
        return Err("missing history type".into());
    }
    if !matches!(&id, Field::Text(value) if value == wanted_id) {
        return Ok(None);
    }
    Ok(Some(Metadata {
        kind: kind.selected()?.ok_or("missing history type")?,
        id: id.selected()?,
        parent_id: parent.selected()?,
        message: if message {
            Some(MessageMetadata {
                role: role.selected()?.ok_or("missing message role")?,
            })
        } else {
            None
        },
        display,
        internal_notification,
    }))
}

enum Field {
    Missing,
    Null,
    Text(String),
    Oversized,
}

impl Field {
    fn selected(self) -> Result<Option<String>> {
        match self {
            Self::Missing | Self::Null => Ok(None),
            Self::Text(value) => Ok(Some(value)),
            Self::Oversized => Err("selected history metadata exceeds 1024 UTF-8 bytes".into()),
        }
    }
}

/// Validates JSON using bounded token storage and a bounded recursive container stack.
struct Scanner<R> {
    reader: R,
}

impl<R: BufRead> Scanner<R> {
    fn peek(&mut self) -> Result<Option<u8>> {
        Ok(self.reader.fill_buf()?.first().copied())
    }

    fn byte(&mut self) -> Result<u8> {
        let byte = self.peek()?.ok_or("unexpected EOF in JSON")?;
        self.reader.consume(1);
        Ok(byte)
    }

    fn peek_nonspace(&mut self) -> Result<Option<u8>> {
        while matches!(self.peek()?, Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.reader.consume(1);
        }
        self.peek()
    }

    fn consume(&mut self, byte: u8) -> Result<bool> {
        if self.peek_nonspace()? == Some(byte) {
            self.reader.consume(1);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn expect(&mut self, byte: u8) -> Result<()> {
        if self.consume(byte)? {
            Ok(())
        } else {
            Err("unexpected JSON token".into())
        }
    }

    fn literal(&mut self, token: &[u8]) -> Result<()> {
        for expected in token {
            if self.byte()? != *expected {
                return Err("invalid JSON literal".into());
            }
        }
        Ok(())
    }

    /// Decodes one Unicode scalar with constant storage; serde validates escapes,
    /// including surrogate pairs, while str validates unescaped UTF-8 scalars.
    fn scalar(&mut self, first: u8) -> Result<char> {
        if first == b'\\' {
            let mut token = [0u8; 14];
            token[0] = b'"';
            token[1] = first;
            token[2] = self.byte()?;
            let mut end = 3;
            if token[2] == b'u' {
                for slot in &mut token[3..7] {
                    *slot = self.byte()?;
                }
                end = 7;
                let hex = std::str::from_utf8(&token[3..7])?;
                let code = u16::from_str_radix(hex, 16)?;
                if (0xd800..=0xdbff).contains(&code) {
                    for slot in &mut token[7..13] {
                        *slot = self.byte()?;
                    }
                    end = 13;
                }
            }
            token[end] = b'"';
            let decoded: String = serde_json::from_slice(&token[..=end])?;
            return decoded
                .chars()
                .next()
                .ok_or_else(|| "empty JSON escape".into());
        }
        let width = match first {
            0x20..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Err("invalid JSON string byte".into()),
        };
        let mut bytes = [0; 4];
        bytes[0] = first;
        for slot in &mut bytes[1..width] {
            *slot = self.byte()?;
        }
        Ok(std::str::from_utf8(&bytes[..width])?
            .chars()
            .next()
            .ok_or("empty UTF-8 scalar")?)
    }

    /// Returns None when capture is disabled or the decoded token exceeds the limit.
    /// Validation continues through the closing quote even after capture stops.
    fn string(&mut self, capture: bool) -> Result<Option<String>> {
        self.expect(b'"')?;
        let mut text = capture.then(|| String::with_capacity(MAX_METADATA_BYTES));
        loop {
            let first = self.byte()?;
            if first == b'"' {
                return Ok(text);
            }
            let scalar = self.scalar(first)?;
            if let Some(value) = &mut text {
                if value.len() + scalar.len_utf8() > MAX_METADATA_BYTES {
                    text = None;
                } else {
                    value.push(scalar);
                }
            }
        }
    }

    fn field(&mut self, nullable: bool) -> Result<Field> {
        if nullable && self.peek_nonspace()? == Some(b'n') {
            self.literal(b"null")?;
            Ok(Field::Null)
        } else {
            Ok(match self.string(true)? {
                Some(text) => Field::Text(text),
                None => Field::Oversized,
            })
        }
    }

    fn message(&mut self) -> Result<Field> {
        self.expect(b'{')?;
        let mut role = Field::Missing;
        if !self.consume(b'}')? {
            loop {
                let key = self.string(true)?;
                self.expect(b':')?;
                if key.as_deref() == Some("role") {
                    if !matches!(role, Field::Missing) {
                        return Err("duplicate message role".into());
                    }
                    role = self.field(false)?;
                } else {
                    self.value(2)?;
                }
                if self.consume(b'}')? {
                    break;
                }
                self.expect(b',')?;
            }
        }
        if matches!(role, Field::Missing) {
            return Err("missing message role".into());
        }
        Ok(role)
    }

    /// Consumes a JSON number lexically without allocating or converting its magnitude.
    fn number(&mut self) -> Result<()> {
        if self.peek()? == Some(b'-') {
            self.byte()?;
        }
        match self.byte()? {
            b'0' => {}
            b'1'..=b'9' => self.digits()?,
            _ => return Err("invalid JSON number".into()),
        }
        if self.peek()? == Some(b'.') {
            self.byte()?;
            if !self.byte()?.is_ascii_digit() {
                return Err("invalid JSON fraction".into());
            }
            self.digits()?;
        }
        if matches!(self.peek()?, Some(b'e' | b'E')) {
            self.byte()?;
            if matches!(self.peek()?, Some(b'+' | b'-')) {
                self.byte()?;
            }
            if !self.byte()?.is_ascii_digit() {
                return Err("invalid JSON exponent".into());
            }
            self.digits()?;
        }
        Ok(())
    }

    fn digits(&mut self) -> Result<()> {
        while self.peek()?.is_some_and(|byte| byte.is_ascii_digit()) {
            self.byte()?;
        }
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<()> {
        match self
            .peek_nonspace()?
            .ok_or("unexpected EOF in JSON value")?
        {
            b'"' => {
                self.string(false)?;
            }
            b'n' => self.literal(b"null")?,
            b't' => self.literal(b"true")?,
            b'f' => self.literal(b"false")?,
            b'-' | b'0'..=b'9' => self.number()?,
            open @ (b'{' | b'[') => {
                if depth >= MAX_DEPTH {
                    return Err("history JSON nesting exceeds 64 containers".into());
                }
                self.byte()?;
                let close = if open == b'{' { b'}' } else { b']' };
                if !self.consume(close)? {
                    loop {
                        if open == b'{' {
                            self.string(false)?;
                            self.expect(b':')?;
                        }
                        self.value(depth + 1)?;
                        if self.consume(close)? {
                            break;
                        }
                        self.expect(b',')?;
                    }
                }
            }
            _ => return Err("invalid JSON value".into()),
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;
