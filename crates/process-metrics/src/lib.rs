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

/// Kernel plus user CPU time of the calling thread, in nanoseconds.
#[cfg(windows)]
pub fn thread_cpu_ns() -> std::io::Result<u64> {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};
    let mut creation = Default::default();
    let mut exit = Default::default();
    let mut kernel = Default::default();
    let mut user = Default::default();
    // SAFETY: the pseudo-handle is valid and all four FILETIME outputs are writable.
    if unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok((filetime_ns(kernel)).saturating_add(filetime_ns(user)))
}
#[cfg(windows)]
fn filetime_ns(time: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) * 100
}

/// Process CPU and individual live-thread counters, sampled in the measured process.
#[derive(Clone, Debug, Default)]
pub struct CpuSnapshot {
    pub total_ns: u64,
    pub threads: std::collections::BTreeMap<u32, u64>,
}
#[cfg(windows)]
pub fn cpu_snapshot() -> std::io::Result<CpuSnapshot> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, GetThreadTimes, OpenThread,
        THREAD_QUERY_LIMITED_INFORMATION,
    };
    let mut creation = Default::default();
    let mut exit = Default::default();
    let mut kernel = Default::default();
    let mut user = Default::default();
    // SAFETY: the pseudo-handle is valid and all four FILETIME outputs are writable.
    if unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let mut result = CpuSnapshot {
        total_ns: filetime_ns(kernel).saturating_add(filetime_ns(user)),
        ..Default::default()
    };
    // SAFETY: the snapshot API takes no pointers and returns an owned handle.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: the snapshot handle is valid and entry has the required size.
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    // SAFETY: this call has no preconditions.
    let pid = unsafe { GetCurrentProcessId() };
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: query access is read-only; a thread exiting concurrently returns null.
            let handle =
                unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, entry.th32ThreadID) };
            if !handle.is_null() {
                // SAFETY: handle has query access and all FILETIME outputs are writable.
                if unsafe {
                    GetThreadTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
                } != 0
                {
                    result.threads.insert(
                        entry.th32ThreadID,
                        filetime_ns(kernel).saturating_add(filetime_ns(user)),
                    );
                }
                // SAFETY: OpenThread returned this owned handle; it is closed once.
                unsafe { CloseHandle(handle) };
            }
        }
        // SAFETY: the snapshot remains open and entry remains writable and correctly sized.
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    // SAFETY: this owned snapshot handle is closed once after enumeration.
    unsafe { CloseHandle(snapshot) };
    Ok(result)
}
#[cfg(not(windows))]
pub fn thread_cpu_ns() -> std::io::Result<u64> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Thread CPU counters unavailable.",
    ))
}
#[cfg(not(windows))]
pub fn cpu_snapshot() -> std::io::Result<CpuSnapshot> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "CPU snapshots unavailable.",
    ))
}

#[cfg(all(test, windows))]
mod cpu_tests {
    #[test]
    fn cpu_counters_are_monotonic_and_include_current_process_threads() {
        let before = super::cpu_snapshot().unwrap();
        let thread_before = super::thread_cpu_ns().unwrap();
        let start = std::time::Instant::now();
        while start.elapsed().as_millis() < 40 {
            std::hint::black_box((0..1000u64).sum::<u64>());
        }
        let after = super::cpu_snapshot().unwrap();
        assert!(super::thread_cpu_ns().unwrap() >= thread_before);
        assert!(after.total_ns >= before.total_ns);
        assert!(!after.threads.is_empty());
    }
}
