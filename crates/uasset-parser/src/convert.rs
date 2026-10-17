//! Integer conversions whose range is already established, so decoding never panics on them.
//!
//! Package fields are read as signed integers, checked (a negative count or offset is a typed
//! error at the read site) and then converted. These helpers state the remaining conversions
//! once instead of repeating `try_from(..).expect(..)` at every site.

// Every target UE Shed builds for has 32- or 64-bit pointers (native hosts and wasm32).
const _: () = assert!(usize::BITS == 32 || usize::BITS == 64);

/// Lossless: `usize` is at most 64 bits on every supported target.
#[must_use]
pub(crate) const fn u64_from_usize(value: usize) -> u64 {
    value as u64
}

/// Lossless: `usize` is at least 32 bits on every supported target.
#[must_use]
pub(crate) const fn usize_from_u32(value: u32) -> usize {
    value as usize
}

/// A value the read site has checked is non-negative. A negative value would be a parser bug:
/// debug builds stop on it, release builds clamp it to zero instead of crashing a host.
#[must_use]
pub(crate) fn u32_from_checked(value: i32) -> u32 {
    debug_assert!(value >= 0, "checked non-negative value {value}");
    u32::try_from(value).unwrap_or(0)
}

/// [`u32_from_checked`] as a `usize`.
#[must_use]
pub(crate) fn usize_from_checked(value: i32) -> usize {
    usize_from_u32(u32_from_checked(value))
}

/// [`u32_from_checked`] for 64-bit fields.
#[must_use]
pub(crate) fn u64_from_checked(value: i64) -> u64 {
    debug_assert!(value >= 0, "checked non-negative value {value}");
    u64::try_from(value).unwrap_or(0)
}

/// A position in an import or export table, whose length came from a 32-bit count.
#[must_use]
pub(crate) fn u32_from_table_index(index: usize) -> u32 {
    debug_assert!(
        u32::try_from(index).is_ok(),
        "table index {index} exceeds u32"
    );
    u32::try_from(index).unwrap_or(u32::MAX)
}
