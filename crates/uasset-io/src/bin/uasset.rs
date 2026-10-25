use std::env;
use std::process::ExitCode;

#[cfg(feature = "reader-memory-probes")]
#[global_allocator]
static HEAP: process_metrics::ThreadCountingAllocator = process_metrics::ThreadCountingAllocator;

fn main() -> ExitCode {
    ExitCode::from(uasset_io::run(env::args_os().skip(1)))
}
