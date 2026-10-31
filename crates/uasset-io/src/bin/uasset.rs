use std::env;
use std::process::ExitCode;

#[cfg(feature = "reader-memory-probes")]
#[global_allocator]
static HEAP: process_metrics::ThreadCountingAllocator = process_metrics::ThreadCountingAllocator;

// The reader allocates from many threads at once. Windows' process heap serializes blocks
// larger than its low-fragmentation sizes on one lock, which stalled parallel parsing and
// publication; mimalloc keeps per-thread heaps.
#[cfg(not(feature = "reader-memory-probes"))]
#[global_allocator]
static HEAP: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> ExitCode {
    ExitCode::from(uasset_io::run(env::args_os().skip(1)))
}
