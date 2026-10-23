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
