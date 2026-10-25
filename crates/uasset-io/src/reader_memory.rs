//! Opt-in, anonymous reader memory timelines. Normal builds compile only the empty hooks.

#[derive(Clone, Copy)]
#[repr(usize)]
pub(crate) enum Stage {
    #[cfg_attr(not(feature = "reader-memory-probes"), allow(dead_code))]
    Read,
    Parse,
    Decode,
    Project,
    Release,
    Serialize,
}

#[cfg(feature = "reader-memory-probes")]
mod capture;
#[cfg(feature = "reader-memory-probes")]
pub(crate) use capture::*;

#[cfg(not(feature = "reader-memory-probes"))]
mod disabled {
    use super::Stage;
    use std::path::PathBuf;

    pub(crate) struct Probe;
    pub(crate) struct Job;
    pub(crate) struct Consuming;
    pub(crate) struct ReadBuffer;

    impl Probe {
        pub(crate) fn new(_: bool) -> Self {
            Self
        }
        pub(crate) fn configure(&self, _: &[PathBuf], _: impl FnOnce() -> [u64; 4]) {}
        pub(crate) fn job(&self, _: usize) -> Job {
            Job
        }
        pub(crate) fn consume(&self, _: usize) -> Consuming {
            Consuming
        }
    }
    impl Job {
        pub(crate) fn ready(&self, _: impl FnOnce() -> (u64, u64)) {}
    }
    pub(crate) fn checkpoint(_: Stage) {}
    pub(crate) fn scheduled(_: usize) {}
    pub(crate) fn read_buffer(_: usize) -> ReadBuffer {
        ReadBuffer
    }
    pub(crate) fn writers(_: impl Iterator<Item = (usize, usize)>) {}
}
#[cfg(not(feature = "reader-memory-probes"))]
pub(crate) use disabled::*;
