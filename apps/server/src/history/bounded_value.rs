//! JSON decoding with an allocation-node budget enforced during construction.
//! The caller bounds input bytes and validates depth with the metadata scanner first.
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

pub(super) struct BoundedValue<'a>(pub &'a mut usize);
impl<'de> DeserializeSeed<'de> for BoundedValue<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if *self.0 == 0 { return Err(de::Error::custom("history node budget exceeded")); }
        *self.0 -= 1;
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for BoundedValue<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("bounded JSON") }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> { Ok(Value::Bool(v)) }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> { Ok(Value::Number(v.into())) }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> { Ok(Value::Number(v.into())) }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> { Number::from_f64(v).map(Value::Number).ok_or_else(|| E::custom("invalid number")) }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> { Ok(Value::String(v.to_owned())) }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> { Ok(Value::String(v)) }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> { Ok(Value::Null) }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> { Ok(Value::Null) }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(BoundedValue(self.0))? { values.push(value); }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if *self.0 == 0 { return Err(de::Error::custom("history node budget exceeded")); }
            *self.0 -= 1;
            values.insert(key, map.next_value_seed(BoundedValue(self.0))?);
        }
        Ok(Value::Object(values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stops_before_decoding_the_unbounded_tail() {
        let mut budget = 3;
        let mut decoder = serde_json::Deserializer::from_str("[0,0,0,INVALID]");
        let error = BoundedValue(&mut budget).deserialize(&mut decoder).unwrap_err();
        assert!(error.to_string().contains("history node budget exceeded"));
    }
}
