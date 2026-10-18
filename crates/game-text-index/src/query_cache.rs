//! Reader-owned query metadata, bounded by serialized bytes and entry count.
use crate::Result;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;

#[derive(Default)]
pub(crate) struct QueryCache {
    entries: VecDeque<(String, Box<[u8]>)>,
    bytes: usize,
}

impl crate::engine_query::EngineQuery {
    pub(crate) fn cached_metadata(
        &mut self,
        key: String,
        cancelled: &AtomicBool,
        compute: impl FnOnce(&mut Self) -> Result<Value>,
    ) -> Result<Value> {
        crate::engine_match::checkpoint(cancelled)?;
        if let Some(value) = self.metadata_cache.get(&key)? {
            crate::engine_match::checkpoint(cancelled)?;
            return Ok(value);
        }
        let value = compute(self)?;
        crate::engine_match::checkpoint(cancelled)?;
        self.metadata_cache.insert(key, &value)?;
        crate::engine_match::checkpoint(cancelled)?;
        Ok(value)
    }
}
impl QueryCache {
    pub(crate) fn get(&mut self, key: &str) -> Result<Option<Value>> {
        let Some(index) = self.entries.iter().position(|(stored, _)| stored == key) else {
            return Ok(None);
        };
        let entry = self
            .entries
            .remove(index)
            .ok_or("Missing query cache entry")?;
        let value = serde_json::from_slice(&entry.1)?;
        self.entries.push_front(entry);
        Ok(Some(value))
    }
    pub(crate) fn insert(&mut self, key: String, value: &Value) -> Result<()> {
        // Large request keys are valid inputs, but need not occupy a reusable cache entry.
        if key.len() > 64 * 1024 {
            return Ok(());
        }
        let bytes = serde_json::to_vec(value)?.into_boxed_slice();
        let size = key.len().saturating_add(bytes.len());
        if size > MAX_BYTES {
            return Ok(());
        }
        if let Some(index) = self.entries.iter().position(|(stored, _)| stored == &key) {
            let (key, value) = self
                .entries
                .remove(index)
                .ok_or("Missing query cache entry")?;
            self.bytes -= key.len() + value.len();
        }
        while self.entries.len() >= MAX_ENTRIES || self.bytes + size > MAX_BYTES {
            let (key, value) = self
                .entries
                .pop_back()
                .ok_or("Invalid query cache budget")?;
            self.bytes -= key.len() + value.len();
        }
        self.bytes += size;
        self.entries.push_front((key, bytes));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reader_caches_are_isolated_and_cancelled_or_failed_calls_do_not_supply_cached_results()
    -> Result<()> {
        use crate::engine_query::EngineQuery;
        use crate::store::{Configuration, Store};
        use std::cell::Cell;
        use std::sync::atomic::Ordering;
        let config = Configuration {
            cache_root: crate::test_directory("query-cache"),
            project_key: "project".into(),
            target_key: "target".into(),
            shared_project: false,
            view_prefix: None,
        };
        let mut store = Store::writer(config.clone())?;
        let meta = json!({"version":3,"generation":store.root["generation"],"count":0,"dependencies":{},"input":{"target":{"name":"Game","cultures":[]}},"packageNames":[],"packageStarts":[0]});
        store.publish_global(
            "joined",
            "joined-native-v2:test",
            &[],
            &serde_json::to_vec(&meta)?,
            &Default::default(),
            &[],
        )?;
        let mut query = EngineQuery::open(&config, None)?;
        let mut other = EngineQuery::open(&config, None)?;
        let cancelled = AtomicBool::new(false);
        let calls = Cell::new(0);
        for _ in 0..2 {
            let mut value = query.cached_metadata("same".into(), &cancelled, |_| {
                calls.set(calls.get() + 1);
                Ok(json!({"count":1}))
            })?;
            assert_eq!(value, json!({"count":1}));
            value["count"] = json!(9);
        }
        assert_eq!(calls.get(), 1);
        assert_eq!(
            other.cached_metadata("same".into(), &cancelled, |_| Ok(json!(2)))?,
            json!(2)
        );
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            query
                .cached_metadata("same".into(), &cancelled, |_| Ok(json!(3)))
                .unwrap_err()
                .code,
            crate::ErrorCode::Cancelled
        );
        cancelled.store(false, Ordering::Relaxed);
        assert!(
            query
                .cached_metadata("failed".into(), &cancelled, |_| Err(
                    "Expected test failure".into()
                ))
                .is_err()
        );
        assert_eq!(
            query.cached_metadata("failed".into(), &cancelled, |_| Ok(json!(4)))?,
            json!(4)
        );
        drop(other);
        drop(query);
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn byte_and_entry_budgets_evict_least_recent_values_and_keep_oversized_results_usable()
    -> Result<()> {
        let mut cache = QueryCache::default();
        for index in 0..MAX_ENTRIES {
            cache.insert(index.to_string(), &json!(index))?;
        }
        assert_eq!(cache.get("0")?, Some(json!(0)));
        cache.insert("next".into(), &json!(true))?;
        assert_eq!(cache.get("1")?, None);
        assert_eq!(cache.get("0")?, Some(json!(0)));
        let large = json!("x".repeat(MAX_BYTES / 2));
        cache.insert("large-a".into(), &large)?;
        cache.insert("large-b".into(), &large)?;
        assert!(cache.bytes <= MAX_BYTES);
        assert_eq!(cache.get("large-a")?, None);
        assert_eq!(cache.get("large-b")?, Some(large));
        cache.insert("oversized".into(), &json!("x".repeat(MAX_BYTES)))?;
        assert_eq!(cache.get("oversized")?, None);
        assert!(cache.get("large-b")?.is_some());
        cache.insert("large-b".into(), &json!("replacement"))?;
        assert!(cache.bytes < 128);
        Ok(())
    }
}
