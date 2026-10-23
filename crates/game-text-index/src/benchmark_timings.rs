//! Opt-in benchmark side channel. Default builds contain none of this instrumentation.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

thread_local! {
    static TIMES: RefCell<BTreeMap<&'static str, f64>> = const { RefCell::new(BTreeMap::new()) };
    static CHILDREN: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
}

fn directory() -> &'static Option<PathBuf> {
    static DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIRECTORY.get_or_init(|| std::env::var_os("UE_SHED_GAME_TEXT_MEASURE_DIR").map(PathBuf::from))
}

pub struct Span {
    stage: &'static str,
    started: Option<Instant>,
}
impl Span {
    pub fn new(stage: &'static str) -> Self {
        let started = directory().as_ref().map(|_| Instant::now());
        if started.is_some() {
            CHILDREN.with_borrow_mut(|stack| stack.push(0.0));
        }
        Self { stage, started }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some(started) = self.started {
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let children = CHILDREN.with_borrow_mut(|stack| {
                let children = stack.pop().unwrap_or(0.0);
                if let Some(parent) = stack.last_mut() {
                    *parent += ms;
                }
                children
            });
            TIMES.with_borrow_mut(|times| {
                *times.entry(self.stage).or_default() += (ms - children).max(0.0)
            });
        }
    }
}

pub fn flush(request_id: &str) -> std::io::Result<()> {
    let Some(directory) = directory() else {
        return Ok(());
    };
    let times = TIMES.with_borrow_mut(std::mem::take);
    let mut output = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(format!("rust-{}.ndjson", std::process::id())))?;
    writeln!(
        output,
        "{}",
        serde_json::json!({ "requestId": request_id, "ms": times })
    )
}
