use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Cooperative cancellation shared by the one-shot IO operation and its bounded workers.
///
/// Protocol v1 has no in-band cancellation frame. The token is therefore also useful for the
/// native executor boundary and deterministic tests; a process-level interruption still
/// terminates the scoped child as documented by the protocol.
#[derive(Clone, Debug, Default)]
pub(crate) struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn checkpoint(&self, stage: &'static str) -> Result<(), &'static str> {
        if self.is_cancelled() {
            Err(stage)
        } else {
            Ok(())
        }
    }
}
