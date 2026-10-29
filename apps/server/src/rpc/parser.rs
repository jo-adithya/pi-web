use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

/// Parses one complete UTF-8 record, bounding tree growth before allocation.
pub(super) fn parse(bytes: &[u8], depth: usize, nodes: usize) -> Result<(Value, usize), String> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut remaining = nodes;
    let mut de = serde_json::Deserializer::from_str(text);
    let value = Seed {
        remaining: &mut remaining,
        depth,
    }
    .deserialize(&mut de)
    .map_err(|e| e.to_string())?;
    de.end().map_err(|e| e.to_string())?;
    Ok((value, nodes - remaining))
}

struct Seed<'a> {
    remaining: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, de: D) -> Result<Value, D::Error> {
        if self.depth == 0 || *self.remaining == 0 {
            return Err(de::Error::custom("JSON depth/node budget exceeded"));
        }
        *self.remaining -= 1;
        de.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("invalid number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(Seed {
            remaining: self.remaining,
            depth: self.depth - 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        // Keys consume nodes too, including duplicates, before their allocation.
        while let Some(key) = map.next_key_seed(Seed {
            remaining: self.remaining,
            depth: self.depth - 1,
        })? {
            let Value::String(key) = key else {
                return Err(de::Error::custom("object key must be string"));
            };
            let value = map.next_value_seed(Seed {
                remaining: self.remaining,
                depth: self.depth - 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn budgets_and_strict_records() {
        assert!(parse(br#"{"x":[1,2]}"#, 8, 5).is_ok());
        assert!(parse(br#"{"x":[1,2]}"#, 8, 4).is_err());
        assert!(parse(b"[[[0]]]", 3, 100).is_err());
        assert!(parse(b"{} {}", 64, 100).is_err());
        assert!(parse(b"\xff", 64, 100).is_err());
    }
}
