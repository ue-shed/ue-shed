//! Process memory counters. Peaks are process-lifetime values, including in long-lived engines.

#[derive(Clone, Copy, Debug, Default)]
pub struct Memory {
    pub private_bytes: u64,
    pub peak_private_bytes: Option<u64>,
    pub working_set_bytes: u64,
    pub peak_working_set_bytes: u64,
}

#[cfg(windows)]
pub fn memory() -> std::io::Result<Memory> {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    counters.cb = size;
    // SAFETY: counters is a writable, correctly sized EX structure; the pseudo-handle refers to
    // this process and needs no closing. The API accepts the base pointer with the EX byte size.
    if unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            size,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Memory {
        private_bytes: counters.PrivateUsage as u64,
        peak_private_bytes: Some(counters.PeakPagefileUsage as u64),
        working_set_bytes: counters.WorkingSetSize as u64,
        peak_working_set_bytes: counters.PeakWorkingSetSize as u64,
    })
}

#[cfg(target_os = "linux")]
pub fn memory() -> std::io::Result<Memory> {
    let status = std::fs::read_to_string("/proc/self/status")?;
    let read = |name: &str| -> std::io::Result<u64> {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .map(|value| value * 1024)
            .ok_or_else(|| std::io::Error::other("Missing process memory counter."))
    };
    Ok(Memory {
        private_bytes: read("RssAnon:")?,
        peak_private_bytes: None,
        working_set_bytes: read("VmRSS:")?,
        peak_working_set_bytes: read("VmHWM:")?,
    })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn memory() -> std::io::Result<Memory> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Process memory counters unavailable.",
    ))
}

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static INSTALLED: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// A system allocator that counts live heap bytes and their peak, for attribution runs. Its
/// atomics cost every allocation, so only an opt-in build installs it as the global allocator.
pub struct CountingAllocator;

// SAFETY: every call forwards to the system allocator with the caller's layout and pointer
// unchanged; the counters are plain atomics and never touch the allocation.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for this layout.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            grow(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: as for `alloc`.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            grow(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: the pointer came from this allocator with this layout.
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: the pointer came from this allocator with this layout.
        let moved = unsafe { System.realloc(pointer, layout, size) };
        if !moved.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            grow(size);
        }
        moved
    }
}
fn grow(size: usize) {
    INSTALLED.store(true, Ordering::Relaxed);
    let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(live, Ordering::Relaxed);
}
/// Live heap bytes, without starting a new peak interval. `None` unless counting is installed.
pub fn heap_live() -> Option<u64> {
    INSTALLED
        .load(Ordering::Relaxed)
        .then(|| LIVE.load(Ordering::Relaxed) as u64)
}
/// Live heap bytes and their peak since the previous call, which starts a new interval.
/// `None` unless `CountingAllocator` is the global allocator.
pub fn heap() -> Option<(u64, u64)> {
    if !INSTALLED.load(Ordering::Relaxed) {
        return None;
    }
    let live = LIVE.load(Ordering::Relaxed);
    let peak = PEAK.swap(live, Ordering::Relaxed).max(live);
    Some((live as u64, peak as u64))
}
