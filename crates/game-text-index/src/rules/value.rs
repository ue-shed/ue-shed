//! Typed scalar-kernel values. JSON is decoded at input and constructed only at emission.
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use std::ops::Index;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Number {
    Int(i64),
    Uint(u64),
    Float(u64),
}
impl Number {
    fn f64(&self) -> f64 {
        match self {
            Self::Int(value) => *value as f64,
            Self::Uint(value) => *value as f64,
            Self::Float(value) => f64::from_bits(*value),
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Object(pub Vec<(String, Value)>);
impl Object {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, key: String, value: Value) {
        if let Some((_, stored)) = self.0.iter_mut().find(|(name, _)| *name == key) {
            *stored = value;
        } else {
            self.0.push((key, value));
        }
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}
impl Index<&str> for Object {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&Value::Null)
    }
}

#[derive(Clone, Debug, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(Number),
    String(Arc<str>),
    Array(Arc<Vec<Value>>),
    Object(Arc<Object>),
}
impl Value {
    pub fn string(value: impl Into<Arc<str>>) -> Self {
        Self::String(value.into())
    }
    pub fn object(value: Object) -> Self {
        Self::Object(Arc::new(value))
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(value) = self {
            Some(*value)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Self::String(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_object(&self) -> Option<&Object> {
        if let Self::Object(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Self::Number(value) = self {
            Some(value.f64())
        } else {
            None
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(Number::Int(value)) => Some(*value),
            Self::Number(Number::Uint(value)) => (*value).try_into().ok(),
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(Number::Uint(value)) => Some(*value),
            Self::Number(Number::Int(value)) => (*value).try_into().ok(),
            _ => None,
        }
    }
    pub fn get<I: ValueIndex>(&self, index: I) -> Option<&Value> {
        index.lookup(self)
    }
    pub fn from_json(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(value) => Self::Bool(*value),
            serde_json::Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    value.into()
                } else if let Some(value) = value.as_u64() {
                    value.into()
                } else {
                    value.as_f64().map_or(Self::Null, Self::from)
                }
            }
            serde_json::Value::String(value) => Self::string(value.as_str()),
            serde_json::Value::Array(values) => values
                .iter()
                .map(Self::from_json)
                .collect::<Vec<_>>()
                .into(),
            serde_json::Value::Object(values) => Self::object(Object(
                values
                    .iter()
                    .map(|(name, value)| (name.clone(), Self::from_json(value)))
                    .collect(),
            )),
        }
    }
    pub fn json(&self) -> serde_json::Value {
        // This conversion belongs to the emission boundary, never scalar execution.
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(value) => (*value).into(),
            Self::Number(Number::Int(value)) => (*value).into(),
            Self::Number(Number::Uint(value)) => (*value).into(),
            Self::Number(Number::Float(value)) => {
                serde_json::Number::from_f64(f64::from_bits(*value))
                    .map_or(serde_json::Value::Null, serde_json::Value::Number)
            }
            Self::String(value) => value.to_string().into(),
            Self::Array(values) => {
                serde_json::Value::Array(values.iter().map(Self::json).collect())
            }
            Self::Object(values) => serde_json::Value::Object(
                values
                    .0
                    .iter()
                    .map(|(name, value)| (name.clone(), value.json()))
                    .collect(),
            ),
        }
    }
}
pub trait ValueIndex {
    fn lookup(self, value: &Value) -> Option<&Value>;
}
impl ValueIndex for usize {
    fn lookup(self, value: &Value) -> Option<&Value> {
        value.as_array()?.get(self)
    }
}
impl ValueIndex for &str {
    fn lookup(self, value: &Value) -> Option<&Value> {
        value.as_object()?.get(self)
    }
}
impl ValueIndex for &String {
    fn lookup(self, value: &Value) -> Option<&Value> {
        value.as_object()?.get(self)
    }
}
impl<I: ValueIndex> Index<I> for Value {
    type Output = Value;
    fn index(&self, key: I) -> &Value {
        self.get(key).unwrap_or(&Value::Null)
    }
}
impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::Number(a), Self::Number(b)) => a == b,
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Array(a), Self::Array(b)) => a == b,
            (Self::Object(a), Self::Object(b)) => {
                a.0.len() == b.0.len() && a.0.iter().all(|(name, value)| b.get(name) == Some(value))
            }
            _ => false,
        }
    }
}
impl PartialEq<str> for Value {
    fn eq(&self, value: &str) -> bool {
        self.as_str() == Some(value)
    }
}
impl PartialEq<&str> for Value {
    fn eq(&self, value: &&str) -> bool {
        self.as_str() == Some(*value)
    }
}
impl PartialEq<bool> for Value {
    fn eq(&self, value: &bool) -> bool {
        self.as_bool() == Some(*value)
    }
}
impl PartialEq<i32> for Value {
    fn eq(&self, value: &i32) -> bool {
        self.as_i64() == Some(i64::from(*value))
    }
}
impl PartialEq<serde_json::Value> for Value {
    fn eq(&self, value: &serde_json::Value) -> bool {
        self == &Self::from_json(value)
    }
}
impl<T: Clone> From<&T> for Value
where
    Value: From<T>,
{
    fn from(value: &T) -> Self {
        Self::from(value.clone())
    }
}
impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}
impl From<String> for Value {
    fn from(value: String) -> Self {
        Self::string(value)
    }
}
impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Self::string(value)
    }
}
impl From<Arc<str>> for Value {
    fn from(value: Arc<str>) -> Self {
        Self::String(value)
    }
}
impl From<f64> for Value {
    fn from(value: f64) -> Self {
        if value.is_finite() {
            Self::Number(Number::Float(if value == 0.0 {
                0.0f64.to_bits()
            } else {
                value.to_bits()
            }))
        } else {
            Self::Null
        }
    }
}
impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Self::Number(Number::Int(value))
    }
}
impl From<u64> for Value {
    fn from(value: u64) -> Self {
        Self::Number(i64::try_from(value).map_or(Number::Uint(value), Number::Int))
    }
}
impl From<usize> for Value {
    fn from(value: usize) -> Self {
        (value as u64).into()
    }
}
impl From<u32> for Value {
    fn from(value: u32) -> Self {
        u64::from(value).into()
    }
}
impl From<i32> for Value {
    fn from(value: i32) -> Self {
        i64::from(value).into()
    }
}
impl<T> From<Option<T>> for Value
where
    Value: From<T>,
{
    fn from(value: Option<T>) -> Self {
        value.map_or(Self::Null, Self::from)
    }
}
impl<T> From<Vec<T>> for Value
where
    Value: From<T>,
{
    fn from(values: Vec<T>) -> Self {
        Self::Array(Arc::new(values.into_iter().map(Self::from).collect()))
    }
}
impl From<&[Value]> for Value {
    fn from(values: &[Value]) -> Self {
        values.to_vec().into()
    }
}
impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(Number::Int(value)) => serializer.serialize_i64(*value),
            Self::Number(Number::Uint(value)) => serializer.serialize_u64(*value),
            Self::Number(Number::Float(value)) => serializer.serialize_f64(f64::from_bits(*value)),
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values.iter() {
                    sequence.serialize_element(value)?;
                }
                sequence.end()
            }
            Self::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.0.len()))?;
                for (name, value) in &values.0 {
                    map.serialize_entry(name, value)?;
                }
                map.end()
            }
        }
    }
}
macro_rules! value {
    ([]) => { $crate::rules::value::Value::from(Vec::<$crate::rules::value::Value>::new()) };
    ([$($value:expr),* $(,)?]) => { $crate::rules::value::Value::from(vec![$($crate::rules::value::Value::from(&$value)),*]) };
    ({$($key:literal: $value:expr),* $(,)?}) => { $crate::rules::value::Value::object($crate::rules::value::Object(vec![$(($key.to_owned(), $crate::rules::value::Value::from(&$value))),*])) };
    ($value:expr) => { $crate::rules::value::Value::from(&$value) };
}
pub(crate) use value;

impl<'de> serde::Deserialize<'de> for Value {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Value;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a typed rule value")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Value, E> {
                Ok(value.into())
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<Value>()? {
                    values.push(value);
                }
                Ok(values.into())
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut entries: A,
            ) -> Result<Value, A::Error> {
                let mut object = Object::new();
                while let Some((name, value)) = entries.next_entry::<String, Value>()? {
                    object.insert(name, value);
                }
                Ok(Value::object(object))
            }
        }
        decoder.deserialize_any(Visitor)
    }
}

impl From<super::grammar::Pattern> for Value {
    fn from(pattern: super::grammar::Pattern) -> Self {
        let arguments = pattern
            .arguments
            .into_iter()
            .map(
                |argument| value!({"name":argument.name,"start":argument.start,"end":argument.end}),
            )
            .collect::<Vec<_>>();
        let modifiers = pattern.modifiers.into_iter().map(|modifier| {
            let forms = modifier.forms.into_iter().map(|form| value!({"name":form.name,"value":form.value})).collect::<Vec<_>>();
            value!({"name":modifier.name,"argument":modifier.argument,"forms":forms,"start":modifier.start,"end":modifier.end,"depth":modifier.depth})
        }).collect::<Vec<_>>();
        let issues = pattern.issues.into_iter().map(|issue| value!({"code":issue.code,"modifier":issue.modifier,"argument":issue.argument,"forms":issue.forms,"position":issue.position})).collect::<Vec<_>>();
        value!({"compiled":pattern.compiled,"arguments":arguments,"modifiers":modifiers,"issues":issues})
    }
}
