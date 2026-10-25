use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

use super::{CancellationToken, Failure, checkpoint};

struct State {
    pending: VecDeque<usize>,
    active_bytes: u64,
    active_jobs: usize,
    peak_bytes: u64,
    peak_jobs: usize,
    budget_waiters: usize,
    waits: u64,
    closed: bool,
}

pub(super) struct JobQueue<'a> {
    sizes: &'a [u64],
    maximum_bytes: u64,
    state: Mutex<State>,
    changed: Condvar,
}

impl<'a> JobQueue<'a> {
    pub(super) fn new(sizes: &'a [u64], maximum_bytes: u64, window: usize) -> Self {
        Self {
            sizes,
            maximum_bytes,
            state: Mutex::new(State {
                pending: VecDeque::with_capacity(window),
                active_bytes: 0,
                active_jobs: 0,
                peak_bytes: 0,
                peak_jobs: 0,
                budget_waiters: 0,
                waits: 0,
                closed: false,
            }),
            changed: Condvar::new(),
        }
    }

    pub(super) fn push(&self, index: usize) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.pending.push_back(index);
        self.changed.notify_all();
    }

    pub(super) fn take(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<Admitted<'_, 'a>>, Failure> {
        let _span = game_text_index::scan_timings::Span::new("extract.budget_admission");
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            checkpoint(cancellation, "budget")?;
            if state.closed {
                return Ok(None);
            }
            // The first fitting pending input wins; an oversized active input excludes even
            // zero-byte jobs until its decoded package has been released.
            let fitting = state.pending.iter().position(|&index| {
                state.active_jobs == 0
                    || (state.active_bytes <= self.maximum_bytes
                        && self.sizes[index] <= self.maximum_bytes - state.active_bytes)
            });
            if let Some(index) = fitting.and_then(|position| state.pending.remove(position)) {
                state.active_bytes += self.sizes[index];
                state.active_jobs += 1;
                state.peak_bytes = state.peak_bytes.max(state.active_bytes);
                state.peak_jobs = state.peak_jobs.max(state.active_jobs);
                return Ok(Some(Admitted { queue: self, index }));
            }
            let budget_wait = !state.pending.is_empty();
            let wait = game_text_index::scan_timings::Span::new(if budget_wait {
                "extract.budget_wait"
            } else {
                "extract.job_wait"
            });
            state.budget_waiters += usize::from(budget_wait);
            state.waits += u64::from(budget_wait);
            let (next, _) = self
                .changed
                .wait_timeout(state, Duration::from_millis(20))
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            state.budget_waiters -= usize::from(budget_wait);
            drop(wait);
        }
    }

    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.closed = true;
        state.pending.clear();
        self.changed.notify_all();
        game_text_index::scan_timings::count("extract.budget_limit_bytes", self.maximum_bytes);
        game_text_index::scan_timings::count("extract.budget_peak_bytes", state.peak_bytes);
        game_text_index::scan_timings::count("extract.budget_peak_jobs", state.peak_jobs as u64);
        game_text_index::scan_timings::count("extract.budget_waits", state.waits);
    }
}

pub(super) struct Admitted<'q, 'a> {
    queue: &'q JobQueue<'a>,
    pub(super) index: usize,
}

impl Drop for Admitted<'_, '_> {
    fn drop(&mut self) {
        let mut state = self
            .queue
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.active_bytes -= self.queue.sizes[self.index];
        state.active_jobs -= 1;
        self.queue.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    fn wait_for_budget_waiter(queue: &JobQueue<'_>) {
        let start = Instant::now();
        while queue.state.lock().unwrap().budget_waiters == 0 {
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "worker did not wait"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn small_inputs_pass_a_large_waiting_input_when_they_fit() {
        let queue = JobQueue::new(&[60, 80, 30], 100, 6);
        let cancellation = CancellationToken::new();
        for index in 0..3 {
            queue.push(index);
        }
        let first = queue.take(&cancellation).unwrap().unwrap();
        let small = queue.take(&cancellation).unwrap().unwrap();
        assert_eq!((first.index, small.index), (0, 2));
        assert_eq!(queue.state.lock().unwrap().active_bytes, 90);
        drop((first, small));
        assert_eq!(queue.take(&cancellation).unwrap().unwrap().index, 1);
        queue.close();
    }

    #[test]
    fn oversized_input_runs_alone_including_against_zero_byte_inputs() {
        let queue = JobQueue::new(&[60, 120, 30, 0], 100, 6);
        let cancellation = CancellationToken::new();
        for index in 0..3 {
            queue.push(index);
        }
        let first = queue.take(&cancellation).unwrap().unwrap();
        let small = queue.take(&cancellation).unwrap().unwrap();
        drop(first);
        std::thread::scope(|scope| {
            let queue = &queue;
            let cancellation = &cancellation;
            let (started, receive) = mpsc::channel();
            scope.spawn(move || {
                let large = queue.take(cancellation).unwrap().unwrap();
                assert_eq!(large.index, 1);
                assert_eq!(queue.state.lock().unwrap().active_jobs, 1);
                queue.push(3);
                started.send(large).unwrap();
            });
            wait_for_budget_waiter(queue);
            assert!(receive.try_recv().is_err());
            drop(small);
            let large = receive.recv_timeout(Duration::from_secs(2)).unwrap();
            let (zero, receive_zero) = mpsc::channel();
            scope.spawn(move || {
                let input = queue.take(cancellation).unwrap().unwrap();
                zero.send(input.index).unwrap();
            });
            wait_for_budget_waiter(queue);
            assert!(receive_zero.try_recv().is_err());
            drop(large);
            assert_eq!(
                receive_zero.recv_timeout(Duration::from_secs(2)).unwrap(),
                3
            );
        });
        queue.close();
    }

    #[test]
    fn cancellation_releases_a_budget_waiter_without_releasing_the_active_input() {
        let queue = JobQueue::new(&[100, 100], 100, 4);
        let cancellation = CancellationToken::new();
        queue.push(0);
        queue.push(1);
        let active = queue.take(&cancellation).unwrap().unwrap();
        std::thread::scope(|scope| {
            let queue = &queue;
            let cancellation = &cancellation;
            let (done, receive) = mpsc::channel();
            scope.spawn(move || {
                let error = queue.take(cancellation).err().expect("cancelled admission");
                done.send(error.code).unwrap();
            });
            wait_for_budget_waiter(queue);
            cancellation.cancel();
            assert_eq!(
                receive.recv_timeout(Duration::from_millis(250)).unwrap(),
                "cancelled"
            );
            assert_eq!(queue.state.lock().unwrap().active_jobs, 1);
        });
        drop(active);
        queue.close();
    }
}
