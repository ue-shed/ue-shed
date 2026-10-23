//! One evaluation-owned recorder for bounded product profiles. No corpus values or node IDs.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub(crate) struct Recorder(Arc<Mutex<Recording>>);
#[derive(Default)]
struct Recording {
    stages: BTreeMap<&'static str, Sample>,
    kernels: BTreeMap<String, Sample>,
}
#[derive(Default)]
struct Sample {
    wall: Duration,
    busy: Duration,
    rows: usize,
    inputs: usize,
    hits: usize,
}
/// All native clocks and worker accounting live here, rather than in persisted metadata.
pub(crate) struct Measure {
    start: Instant,
    parallel: Duration,
    workers: Duration,
    excluded: Duration,
}
impl Measure {
    pub fn start() -> Self {
        Self {
            start: Instant::now(),
            parallel: Duration::ZERO,
            workers: Duration::ZERO,
            excluded: Duration::ZERO,
        }
    }
    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }
    pub fn parallel<T, U: Send>(
        &mut self,
        values: &[T],
        run: impl Fn(&T) -> U + Sync + Send,
    ) -> Vec<U>
    where
        T: Send + Sync,
    {
        use rayon::prelude::*;
        let started = Instant::now();
        let chunks = values
            .par_chunks(256)
            .map(|chunk| {
                let started = Instant::now();
                let result = chunk.iter().map(&run).collect::<Vec<_>>();
                (result, started.elapsed())
            })
            .collect::<Vec<_>>();
        self.parallel += started.elapsed();
        let mut results = Vec::with_capacity(values.len());
        for (chunk, busy) in chunks {
            self.workers += busy;
            results.extend(chunk);
        }
        results
    }
    pub fn exclude(&mut self, duration: Duration) {
        self.excluded += duration;
    }
    fn times(&self) -> (Duration, Duration) {
        let wall = self.elapsed().saturating_sub(self.excluded);
        (wall, wall.saturating_sub(self.parallel) + self.workers)
    }
}
impl Recorder {
    pub fn stage(&self, name: &'static str, measure: &Measure, rows: usize) {
        let (wall, busy) = measure.times();
        let mut recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sample = recording.stages.entry(name).or_default();
        sample.wall += wall;
        sample.busy += busy;
        sample.rows += rows;
    }
    pub fn kernel(&self, op: &str, measure: &Measure, rows: usize, inputs: usize, hits: usize) {
        let (wall, busy) = measure.times();
        let mut recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sample = recording.kernels.entry(op.to_owned()).or_default();
        sample.wall += wall;
        sample.busy += busy;
        sample.rows += rows;
        sample.inputs += inputs;
        sample.hits += hits;
    }
    #[cfg(test)]
    pub fn node_stats(&self, program: &super::Program) -> TestStats {
        let recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut seen = std::collections::HashSet::new();
        TestStats {
            nodes: program
                .nodes
                .iter()
                .map(|node| TestNode {
                    tuples: if seen.insert(&node.op) {
                        recording
                            .kernels
                            .get(&node.op)
                            .map_or(0, |sample| sample.inputs)
                    } else {
                        0
                    },
                })
                .collect(),
        }
    }
    pub fn kernel_wall(&self) -> Duration {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .kernels
            .values()
            .map(|sample| sample.wall)
            .sum()
    }
    pub fn worker_adjustment(&self) -> i128 {
        let recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        recording
            .kernels
            .values()
            .map(|sample| sample.busy.as_nanos() as i128 - sample.wall.as_nanos() as i128)
            .sum()
    }
    pub fn stage_with_kernels(
        &self,
        name: &'static str,
        measure: &Measure,
        rows: usize,
        before: i128,
    ) {
        let wall = measure.elapsed();
        let adjustment = self.worker_adjustment() - before;
        let busy = Duration::from_nanos(
            (wall.as_nanos() as i128 + adjustment)
                .max(0)
                .min(u64::MAX as i128) as u64,
        );
        let mut recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sample = recording.stages.entry(name).or_default();
        sample.wall += wall;
        sample.busy += busy;
        sample.rows += rows;
    }
    pub fn profile(&self, rules: usize, findings: usize, diagnostics: usize) -> Value {
        let recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sample = |sample: &Sample| json!({"wallMs":sample.wall.as_secs_f64()*1000.0,"busyMs":sample.busy.as_secs_f64()*1000.0,"rows":sample.rows,"inputs":sample.inputs,"memoHits":sample.hits});
        json!({"cached":false,"rules":rules,"findings":findings,"diagnostics":diagnostics,
            "stages":recording.stages.iter().map(|(name,value)| ((*name).to_owned(),sample(value))).collect::<serde_json::Map<_,_>>(),
            "kernels":recording.kernels.iter().map(|(name,value)| (name.clone(),sample(value))).collect::<serde_json::Map<_,_>>()})
    }
}
pub(crate) fn subject_stage(subject: super::Subject, phase: &str) -> &'static str {
    use super::Subject::*;
    match (subject, phase) {
        (Line, "execute") => "line.execute",
        (Line, "diagnostics") => "line.diagnostics",
        (Line, _) => "line.emission",
        (LineCulture, "execute") => "line_culture.execute",
        (LineCulture, "diagnostics") => "line_culture.diagnostics",
        (LineCulture, _) => "line_culture.emission",
        (UnitSource, "execute") => "unit_source.execute",
        (UnitSource, "diagnostics") => "unit_source.diagnostics",
        (UnitSource, _) => "unit_source.emission",
    }
}

#[cfg(test)]
pub(crate) struct TestNode {
    pub tuples: usize,
}
#[cfg(test)]
pub(crate) struct TestStats {
    pub nodes: Vec<TestNode>,
}
