//! Reader caches that concurrent requests share. A request computes outside any lock and stores
//! its result; two requests may compute the same value once each, and the first store wins. The
//! locks don't poison: a request that panics leaves a cache as it was before its store.
use crate::Result;
use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

/// A mutex that a panicking holder doesn't poison. Every guarded value here is a cache or a
/// registry whose single-step updates leave it consistent.
#[derive(Default)]
pub(crate) struct Lock<T>(Mutex<T>);
impl<T> Lock<T> {
    pub fn new(value: T) -> Self {
        Self(Mutex::new(value))
    }
    pub fn lock(&self) -> MutexGuard<'_, T> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A value built at most once per reader, on first use.
pub(crate) struct Once<T>(OnceLock<T>);
impl<T> Default for Once<T> {
    fn default() -> Self {
        Self(OnceLock::new())
    }
}
impl<T: Clone> Once<T> {
    pub fn get(&self) -> Option<T> {
        self.0.get().cloned()
    }
    /// The value, built by `build` when no request has stored one yet.
    pub fn get_or_try(&self, build: impl FnOnce() -> Result<T>) -> Result<T> {
        if let Some(value) = self.0.get() {
            return Ok(value.clone());
        }
        let value = build()?;
        Ok(self.0.get_or_init(|| value).clone())
    }
    /// Stores `value` unless a value is already stored, and returns the stored one.
    pub fn store(&self, value: T) -> T {
        self.0.get_or_init(|| value).clone()
    }
}

/// Values by key, each built once on first use.
pub(crate) struct Memo<K, V>(Lock<HashMap<K, V>>);
impl<K, V> Default for Memo<K, V> {
    fn default() -> Self {
        Self(Lock::new(HashMap::new()))
    }
}
impl<K: Hash + Eq, V: Clone> Memo<K, V> {
    pub fn get<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.0.lock().get(key).cloned()
    }
    /// Stores `value` under `key` unless a value is already stored, and returns the stored one.
    pub fn store(&self, key: K, value: V) -> V {
        self.0.lock().entry(key).or_insert(value).clone()
    }
    /// The value under `key`, built by `build` when no request has stored one yet.
    pub fn get_or_try(&self, key: K, build: impl FnOnce() -> Result<V>) -> Result<V> {
        if let Some(value) = self.get(&key) {
            return Ok(value);
        }
        let value = build()?;
        Ok(self.store(key, value))
    }
    /// Runs `update` on the map, for caches that evict.
    pub fn with<R>(&self, update: impl FnOnce(&mut HashMap<K, V>) -> R) -> R {
        update(&mut self.0.lock())
    }
}
