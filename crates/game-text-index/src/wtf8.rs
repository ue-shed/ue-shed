//! Canonical WTF-8. UTF-16 strings never pass through a lossy Rust `String`.
use crate::{Result, require};

#[derive(Clone, Default, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Wtf8Buf(Vec<u8>);
/// Decode JSON boundary strings into reversible views, including lone UTF-16 surrogates.
pub fn parse_json_as<T: serde::de::DeserializeOwned>(text: &str) -> Result<T> {
    crate::json_value::parse_as(text)
}
impl Wtf8Buf {
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self> {
        validate(&bytes)?;
        Ok(Self(bytes))
    }
    pub fn from_utf16(units: &[u16]) -> Self {
        let mut bytes = Vec::with_capacity(units.len());
        let mut i = 0;
        while i < units.len() {
            let unit = u32::from(units[i]);
            let point = if (0xd800..=0xdbff).contains(&unit)
                && units
                    .get(i + 1)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
            {
                i += 1;
                0x10000 + ((unit - 0xd800) << 10) + (u32::from(units[i]) - 0xdc00)
            } else {
                unit
            };
            encode(point, &mut bytes);
            i += 1;
        }
        Self(bytes)
    }
    pub fn from_utf8(text: &str) -> Self {
        Self(text.as_bytes().to_vec())
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
    #[expect(
        clippy::expect_used,
        reason = "Wtf8Buf bytes are private and all constructors validate or encode canonical WTF-8"
    )]
    pub fn to_utf16(&self) -> Vec<u16> {
        let mut units = Vec::new();
        let mut i = 0;
        while i < self.0.len() {
            let (point, length) = point(&self.0, i).expect("validated WTF-8 invariant");
            i += length;
            if point <= 0xffff {
                units.push(point as u16);
            } else {
                let point = point - 0x10000;
                units.push(0xd800 + (point >> 10) as u16);
                units.push(0xdc00 + (point & 0x3ff) as u16);
            }
        }
        units
    }
    pub fn to_utf8(&self) -> Result<&str> {
        Ok(std::str::from_utf8(&self.0)?)
    }
    /// A reversible scalar view for Rust's string policies. Reserved scalars are escaped;
    /// no replacement characters are introduced. Only `from_view` may encode this view.
    #[expect(
        clippy::expect_used,
        reason = "private canonical WTF-8 bytes decode into valid scalars or the reserved surrogate scalar range"
    )]
    pub fn to_view(&self) -> String {
        if let Ok(text) = std::str::from_utf8(&self.0)
            && !self.0.contains(&0xf3)
        {
            return text.to_owned();
        }
        let mut result = String::new();
        let mut i = 0;
        while i < self.0.len() {
            let (value, length) = point(&self.0, i).expect("validated WTF-8");
            i += length;
            if (0xd800..=0xdfff).contains(&value) {
                result.push(char::from_u32(0xf0001 + value - 0xd800).expect("reserved scalar"));
            } else {
                if (0xf0000..=0xf0800).contains(&value) {
                    result.push('\u{f0000}');
                }
                result.push(char::from_u32(value).expect("scalar invariant"));
            }
        }
        result
    }
    /// Ordinary UTF-8 transfers its allocation directly into the policy view.
    pub fn into_view(self) -> String {
        match String::from_utf8(self.0) {
            Ok(text) if !text.as_bytes().contains(&0xf3) => text,
            Ok(text) => Self(text.into_bytes()).to_view(),
            Err(error) => Self(error.into_bytes()).to_view(),
        }
    }
    #[expect(
        clippy::expect_used,
        reason = "callers pass only views produced by to_view or json_value; literal reserved scalars are escaped there"
    )]
    pub fn from_view(view: &str) -> Self {
        if !view.as_bytes().contains(&0xf3) {
            return Self::from_utf8(view);
        }
        let mut units = Vec::with_capacity(view.len());
        let mut chars = view.chars();
        while let Some(value) = chars.next() {
            let value = if value == '\u{f0000}' {
                u32::from(chars.next().expect("escaped scalar view"))
            } else if ('\u{f0001}'..='\u{f0800}').contains(&value) {
                0xd800 + u32::from(value) - 0xf0001
            } else {
                u32::from(value)
            };
            if value <= 0xffff {
                units.push(value as u16);
            } else {
                let value = value - 0x10000;
                units.extend_from_slice(&[
                    0xd800 + (value >> 10) as u16,
                    0xdc00 + (value & 1023) as u16,
                ]);
            }
        }
        Self::from_utf16(&units)
    }
    /// JSON spelling that preserves each UTF-16 code unit, including lone surrogates.
    #[expect(
        clippy::expect_used,
        reason = "canonical private WTF-8 bytes decode into scalars; writing to String is infallible"
    )]
    pub fn json_string(&self) -> String {
        let mut out = String::from("\"");
        let mut at = 0;
        while at < self.0.len() {
            let (unit, length) = point(&self.0, at).expect("validated WTF-8");
            at += length;
            match unit {
                0x22 => out.push_str("\\\""),
                0x5c => out.push_str("\\\\"),
                8 => out.push_str("\\b"),
                9 => out.push_str("\\t"),
                10 => out.push_str("\\n"),
                12 => out.push_str("\\f"),
                13 => out.push_str("\\r"),
                0..=31 | 0xd800..=0xdfff => {
                    use std::fmt::Write;
                    write!(&mut out, "\\u{unit:04x}").expect("String write");
                }
                _ => out.push(char::from_u32(unit).expect("scalar")),
            }
        }
        out.push('"');
        out
    }
}
fn encode(point: u32, out: &mut Vec<u8>) {
    match point {
        0..=0x7f => out.push(point as u8),
        0x80..=0x7ff => {
            out.extend_from_slice(&[(0xc0 | (point >> 6)) as u8, (0x80 | (point & 63)) as u8])
        }
        0x800..=0xffff => out.extend_from_slice(&[
            (0xe0 | (point >> 12)) as u8,
            (0x80 | ((point >> 6) & 63)) as u8,
            (0x80 | (point & 63)) as u8,
        ]),
        _ => out.extend_from_slice(&[
            (0xf0 | (point >> 18)) as u8,
            (0x80 | ((point >> 12) & 63)) as u8,
            (0x80 | ((point >> 6) & 63)) as u8,
            (0x80 | (point & 63)) as u8,
        ]),
    }
}
fn point(bytes: &[u8], i: usize) -> Result<(u32, usize)> {
    let b = *bytes.get(i).ok_or("truncated WTF-8")?;
    let (length, min, mut value) = match b {
        0..=0x7f => return Ok((u32::from(b), 1)),
        0xc2..=0xdf => (2, 0x80, u32::from(b & 31)),
        0xe0..=0xef => (3, 0x800, u32::from(b & 15)),
        0xf0..=0xf4 => (4, 0x10000, u32::from(b & 7)),
        _ => return Err(format!("invalid WTF-8 lead at byte {i}").into()),
    };
    for next in 1..length {
        let byte = *bytes
            .get(i + next)
            .ok_or_else(|| format!("truncated WTF-8 at byte {i}"))?;
        require(byte & 0xc0 == 0x80, "invalid WTF-8 continuation")?;
        value = (value << 6) | u32::from(byte & 63);
    }
    require(
        value >= min && value <= 0x10ffff,
        "overlong or out-of-range WTF-8",
    )?;
    Ok((value, length))
}
pub fn validate(bytes: &[u8]) -> Result<()> {
    if std::str::from_utf8(bytes).is_ok() {
        return Ok(());
    }
    let mut i = 0;
    let mut lead = false;
    while i < bytes.len() {
        let (value, length) = point(bytes, i)?;
        require(
            !(lead && (0xdc00..=0xdfff).contains(&value)),
            "non-canonical WTF-8 surrogate pair",
        )?;
        lead = (0xd800..=0xdbff).contains(&value);
        i += length;
    }
    Ok(())
}
/// Serialize values whose strings are reversible scalar views, with exact JSON UTF-16 escapes.
pub fn view_json(value: &serde_json::Value) -> Result<String> {
    Ok(match value {
        serde_json::Value::String(text) => Wtf8Buf::from_view(text).json_string(),
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(view_json)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        ),
        serde_json::Value::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| Ok(format!(
                    "{}:{}",
                    Wtf8Buf::from_view(key).json_string(),
                    view_json(value)?
                )))
                .collect::<Result<Vec<_>>>()?
                .join(",")
        ),
        _ => serde_json::to_string(value)?,
    })
}
pub(crate) fn expand_utf16(
    value: &str,
    fields: &std::collections::BTreeMap<String, Vec<u16>>,
) -> crate::wtf8::Wtf8Buf {
    if fields.is_empty() {
        return crate::wtf8::Wtf8Buf::from_utf8(value);
    }
    let mut units = Vec::new();
    let mut remainder = value;
    while !remainder.is_empty() {
        let next = fields
            .iter()
            .filter(|(handle, _)| !handle.is_empty())
            .filter_map(|(handle, units)| {
                remainder.find(handle).map(|offset| (offset, handle, units))
            })
            .min_by_key(|v| v.0);
        let Some((offset, handle, raw)) = next else {
            units.extend(remainder.encode_utf16());
            break;
        };
        units.extend(remainder[..offset].encode_utf16());
        units.extend_from_slice(raw);
        remainder = &remainder[offset + handle.len()..];
    }
    crate::wtf8::Wtf8Buf::from_utf16(&units)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_utf16_golden_bytes() {
        for (units, expected) in [
            (vec![0xd800], vec![0xed, 0xa0, 0x80]),
            (vec![0xdfff], vec![0xed, 0xbf, 0xbf]),
            (vec![0xd800, 0xdc00], vec![0xf0, 0x90, 0x80, 0x80]),
            (
                vec![0xdc00, 0xd800],
                vec![0xed, 0xb0, 0x80, 0xed, 0xa0, 0x80],
            ),
            (vec![0x61, 0xd800, 0x62], vec![0x61, 0xed, 0xa0, 0x80, 0x62]),
        ] {
            let value = Wtf8Buf::from_utf16(&units);
            assert_eq!(value.as_bytes(), expected);
            assert_eq!(value.to_utf16(), units);
            assert_eq!(Wtf8Buf::from_bytes(expected).unwrap(), value);
        }
    }
    #[test]
    fn rejects_all_noncanonical_sequences() {
        for bytes in [
            vec![0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80],
            vec![0xc0, 0x80],
            vec![0xe0, 0x80, 0x80],
            vec![0xf0, 0x80, 0x80, 0x80],
            vec![0xf4, 0x90, 0x80, 0x80],
            vec![0xff],
            vec![0x80],
            vec![0xed, 0xa0],
        ] {
            assert!(validate(&bytes).is_err(), "{bytes:?}");
        }
    }
    #[test]
    fn every_utf16_code_unit_round_trips() {
        for unit in 0..=u16::MAX {
            let units = [unit];
            assert_eq!(Wtf8Buf::from_utf16(&units).to_utf16(), units);
        }
        for high in [0xd800, 0xd83d, 0xdbff] {
            for low in [0xdc00, 0xde00, 0xdfff] {
                let units = [high, low];
                let value = Wtf8Buf::from_utf16(&units);
                assert_eq!(value.to_utf16(), units);
                assert!(value.to_utf8().is_ok());
            }
        }
    }
    #[test]
    fn scalar_view_is_exact_and_collision_free() {
        for point in [0, 0x61, 0xd800, 0xdfff, 0xf0000, 0xf0001, 0xf0800, 0x10ffff] {
            let mut bytes = Vec::new();
            encode(point, &mut bytes);
            let value = Wtf8Buf::from_bytes(bytes).unwrap();
            assert_eq!(Wtf8Buf::from_view(&value.to_view()), value);
            assert_eq!(value.clone().into_view(), value.to_view());
        }
        let value = Wtf8Buf::from_utf16(&[0xd800, 0x61, 0xdc00]);
        assert_eq!(value.json_string(), "\"\\ud800a\\udc00\"");
    }
    #[test]
    fn json_object_keys_preserve_the_scalar_view() {
        let key = Wtf8Buf::from_utf16(&[0xd800]).to_view();
        let value = serde_json::json!({key: "value"});
        assert_eq!(view_json(&value).unwrap(), r#"{"\ud800":"value"}"#);
    }
    #[test]
    fn concatenated_scalar_views_canonicalize_pairs() {
        let high = Wtf8Buf::from_utf16(&[0xd800]).to_view();
        let low = Wtf8Buf::from_utf16(&[0xdc00]).to_view();
        let value = Wtf8Buf::from_view(&(high + &low));
        assert_eq!(value.as_bytes(), [0xf0, 0x90, 0x80, 0x80]);
        assert_eq!(value.json_string(), "\"𐀀\"");
        assert_eq!(
            Wtf8Buf::from_utf8("é\n\t\u{1}").json_string(),
            "\"é\\n\\t\\u0001\""
        );
    }
}
