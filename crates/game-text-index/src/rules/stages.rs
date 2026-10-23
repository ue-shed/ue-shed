//! One evaluation-owned recorder for bounded product profiles. No corpus values or node IDs.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub(crate) struct Recorder(Arc<Mutex<Recording>>);
struct Recording {
    origin: Instant,
    active: &'static str,
    stage_kernels: BTreeMap<&'static str, BTreeMap<String, Sample>>,
    stages: BTreeMap<&'static str, Sample>,
    kernels: BTreeMap<String, Sample>,
}
impl Default for Recording {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
            active: "",
            stage_kernels: BTreeMap::new(),
            stages: BTreeMap::new(),
            kernels: BTreeMap::new(),
        }
    }
}
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Memory {
    pub peak_working_set_bytes: u64,
    pub arena_bytes: usize,
    pub side_dictionary_bytes: usize,
    pub live_node_columns_bytes: usize,
    pub memos_bytes: usize,
    pub occurrence_relation_bytes: usize,
}
#[derive(Default)]
struct Sample {
    start: Option<Duration>,
    end: Duration,
    memory: Memory,
    wall: Duration,
    busy: Duration,
    rows: usize,
    inputs: usize,
    hits: usize,
}
/// All native clocks and worker accounting live here, rather than in persisted metadata.
pub struct Measure {
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
        self.parallel_chunks(values, 256, run)
    }
    pub fn parallel_chunks<T: Send + Sync, U: Send>(
        &mut self,
        values: &[T],
        chunk_size: usize,
        run: impl Fn(&T) -> U + Sync + Send,
    ) -> Vec<U> {
        use rayon::prelude::*;
        let started = Instant::now();
        let chunks = values
            .par_chunks(chunk_size)
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
    pub fn include(&mut self, other: &Self) {
        self.parallel += other.parallel;
        self.workers += other.workers;
    }
    pub fn exclude(&mut self, duration: Duration) {
        self.excluded += duration;
    }
    pub fn wall(&self) -> Duration {
        self.elapsed().saturating_sub(self.excluded)
    }
    fn times(&self) -> (Duration, Duration) {
        let wall = self.elapsed().saturating_sub(self.excluded);
        (wall, wall.saturating_sub(self.parallel) + self.workers)
    }
}
impl Recorder {
    pub fn at(measure: &Measure) -> Self {
        Self(Arc::new(Mutex::new(Recording {
            origin: measure.start,
            ..Recording::default()
        })))
    }
    pub fn enter(&self, name: &'static str) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active = name;
    }
    pub fn memory(&self, name: &'static str, mut memory: Memory) {
        memory.peak_working_set_bytes = process_peak();
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stages
            .entry(name)
            .or_default()
            .memory = memory;
    }
    pub fn stage(&self, name: &'static str, measure: &Measure, rows: usize) {
        let (wall, busy) = measure.times();
        let mut recording = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let start = measure.start.saturating_duration_since(recording.origin);
        let end = recording.origin.elapsed();
        let sample = recording.stages.entry(name).or_default();
        sample.start.get_or_insert(start);
        sample.end = end;
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
        let active = recording.active;
        for staged in [false, true] {
            let sample = if staged {
                recording
                    .stage_kernels
                    .entry(active)
                    .or_default()
                    .entry(op.to_owned())
                    .or_default()
            } else {
                recording.kernels.entry(op.to_owned()).or_default()
            };
            sample.wall += wall;
            sample.busy += busy;
            sample.rows += rows;
            sample.inputs += inputs;
            sample.hits += hits;
        }
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
                    tuples: if seen.insert(node.op.name()) {
                        recording
                            .kernels
                            .get(node.op.name())
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
        let start = measure.start.saturating_duration_since(recording.origin);
        let end = recording.origin.elapsed();
        let sample = recording.stages.entry(name).or_default();
        sample.start.get_or_insert(start);
        sample.end = end;
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
            "stages":recording.stages.iter().map(|(name,value)| {
                let mut result = sample(value);
                result["startOffsetMs"] = json!(value.start.unwrap_or_default().as_secs_f64()*1000.0);
                result["endOffsetMs"] = json!(value.end.as_secs_f64()*1000.0);
                result["memory"] = json!(value.memory);
                result["kernels"] = json!(recording.stage_kernels.get(name).map(|kernels| kernels.iter().map(|(name,value)| (name.clone(),sample(value))).collect::<serde_json::Map<_,_>>()).unwrap_or_default());
                ((*name).to_owned(),result)
            }).collect::<serde_json::Map<_,_>>(),
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

/// A single hidden Windows metrics helper avoids both unsafe FFI in this crate and a process
/// launch at every stage. It exits on EOF when the native process closes its pipe.
#[cfg(windows)]
fn process_peak() -> u64 {
    use std::io::{BufRead, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    type Probe = Option<(Child, ChildStdin, std::io::BufReader<ChildStdout>)>;
    static PROBE: std::sync::OnceLock<Mutex<Probe>> = std::sync::OnceLock::new();
    let mut probe = PROBE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let read = || -> std::io::Result<u64> {
        if probe.is_none() {
            let mut child = Command::new("powershell.exe").creation_flags(0x0800_0000)
                .args(["-NoProfile","-NonInteractive","-Command", "$ErrorActionPreference='Stop'; while($null -ne ($line=[Console]::ReadLine())) { [Console]::WriteLine((Get-Process -Id ([int]$line)).PeakWorkingSet64) }"])
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
            let input = child.stdin.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
            let output = child.stdout.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
            *probe = Some((child, input, std::io::BufReader::new(output)));
        }
        let (_, input, output) = probe.as_mut().ok_or(std::io::ErrorKind::BrokenPipe)?;
        writeln!(input, "{}", std::process::id())?;
        input.flush()?;
        let mut line = String::new();
        output.read_line(&mut line)?;
        line.trim().parse().map_err(std::io::Error::other)
    };
    let mut read = read;
    read().unwrap_or(0)
}
#[cfg(target_os = "linux")]
fn process_peak() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                line.strip_prefix("VmHWM:")
                    .and_then(|value| value.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
            })
        })
        .unwrap_or(0)
        * 1024
}
#[cfg(not(any(windows, target_os = "linux")))]
fn process_peak() -> u64 {
    0
}
