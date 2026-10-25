//! The engine's binary session, `uasset game-text-engine`.
//!
//! Every message is one frame: a 12-byte little-endian header (body length, kind, flags, two
//! reserved bytes and the host's request ID) and its body. Requests and replies are JSON with the
//! contract's generated types; the request body is read WTF-8-aware, so lone UTF-16 units and the
//! rule IR travel inline. After the handshake neither side checks the other's frames: a malformed
//! one is a defect, and the session ends.
use crate::engine::{EngineRequest, EngineSession, Profile, Reply};
use crate::{Error, ErrorCode, Result};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError, mpsc};
use std::time::{Duration, Instant};
#[cfg(test)]
use ts_rs::TS;

/// Header bytes before each body.
pub const HEADER: usize = 12;
/// The largest body a frame carries, in either direction.
pub const MAX_BODY: usize = 8 << 20;
/// `flags` bit 0: the request's last frame.
pub const LAST: u8 = 1;
/// Batches a request may send that the host hasn't consumed.
pub const WINDOW: u32 = 8;

/// What a frame carries. Hosts send the first three; the engine sends the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// JSON: an `EngineRequest`.
    Request = 1,
    /// No body: stop the request.
    Cancel = 2,
    /// JSON `{ frames }`: the host consumed this many of the request's row frames.
    Credit = 3,
    /// JSON: one part of an answer that isn't rows.
    Part = 16,
    /// A column batch.
    Batch = 17,
    /// UTF-8 rows a sink encoded for the stream.
    Text = 18,
    /// JSON: a request's progress.
    Progress = 19,
    /// JSON `EngineEnd`: the request finished.
    End = 20,
    /// JSON `EngineFailure`: the request failed.
    Error = 21,
    /// JSON `EngineEnd`: the request stopped when cancelled.
    Cancelled = 22,
}
impl Kind {
    fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            1 => Self::Request,
            2 => Self::Cancel,
            3 => Self::Credit,
            16 => Self::Part,
            17 => Self::Batch,
            18 => Self::Text,
            19 => Self::Progress,
            20 => Self::End,
            21 => Self::Error,
            22 => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug)]
pub struct Frame {
    pub kind: Kind,
    pub flags: u8,
    pub request: u32,
    pub body: Vec<u8>,
}

fn malformed(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// The next frame, or `None` when the input ends between frames.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0; HEADER];
    let mut filled = 0;
    while filled < HEADER {
        match input.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(malformed("The input ended inside a frame header.")),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let length = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if length > MAX_BODY {
        return Err(malformed("A frame body exceeds 8 MiB."));
    }
    let kind = Kind::from_byte(header[4]).ok_or_else(|| malformed("Unknown frame kind."))?;
    if header[6..8] != [0, 0] {
        return Err(malformed("A frame's reserved bytes are set."));
    }
    let mut body = vec![0; length];
    input.read_exact(&mut body)?;
    Ok(Some(Frame {
        kind,
        flags: header[5],
        request: u32::from_le_bytes([header[8], header[9], header[10], header[11]]),
        body,
    }))
}

pub fn write_frame(
    output: &mut impl Write,
    kind: Kind,
    flags: u8,
    request: u32,
    body: &[u8],
) -> io::Result<()> {
    if body.len() > MAX_BODY {
        return Err(malformed("A frame body exceeds 8 MiB."));
    }
    let mut header = [0; HEADER];
    header[0..4].copy_from_slice(&(body.len() as u32).to_le_bytes());
    header[4] = kind as u8;
    header[5] = flags;
    header[8..12].copy_from_slice(&request.to_le_bytes());
    output.write_all(&header)?;
    output.write_all(body)
}

/// A failed request's typed error.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
pub struct EngineError {
    #[cfg_attr(
        test,
        ts(
            type = "\"busy\" | \"cancelled\" | \"invalid_input\" | \"invalid_cache\" | \"limit_exceeded\" | \"stale_generation\" | \"unavailable\" | \"not_found\" | \"io_error\" | \"internal\""
        )
    )]
    pub code: &'static str,
    pub message: String,
}

/// The body of a `credit` frame: the request's batches the host consumed since its last one.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Credit {
    frames: u32,
}

/// The body of an `end` or `cancelled` frame.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
pub struct EngineEnd {
    pub profile: Profile,
}

/// The body of an `error` frame.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
pub struct EngineFailure {
    pub error: EngineError,
    pub profile: Profile,
}

/// A request's terminal frame body when encoding its own failed: an internal error.
const ENCODING_FAILED: &[u8] = br#"{"error":{"code":"internal","message":"The engine could not encode its answer."},"profile":{"io":{"opens":0,"sectionLoads":0,"storedBytes":0,"rawBytes":0,"fullVerifies":0,"indexBytes":0,"writtenBytes":0},"stageSeconds":{}}}"#;

/// Reads a request body: JSON text, its strings read as reversible views.
fn request(body: &[u8]) -> Result<EngineRequest> {
    let text = std::str::from_utf8(body).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "A request is not UTF-8.", source)
    })?;
    crate::json_value::parse_as(text).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid engine request.", source)
    })
}

/// Which threads serve a request. Interactive requests answer a keystroke or a selection; bulk
/// requests open readers, evaluate rules, read whole relations and write files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Interactive,
    Bulk,
}
impl Class {
    pub fn of(request: &EngineRequest) -> Self {
        match request {
            EngineRequest::Capabilities
            | EngineRequest::Close { .. }
            | EngineRequest::Summary { .. }
            | EngineRequest::Search { .. }
            | EngineRequest::Focus { .. }
            | EngineRequest::LocalizationDetail { .. }
            | EngineRequest::Related { .. }
            | EngineRequest::RulesCheck { .. } => Self::Interactive,
            _ => Self::Bulk,
        }
    }
}

/// Threads that run interactive requests. They have their own pool, so a keystroke's parallel
/// work never queues behind an evaluation's.
const INTERACTIVE_THREADS: usize = 2;
/// Bulk requests that run at once, on the shared pool; later ones wait their turn.
const BULK_REQUESTS: usize = 2;
/// Request bodies the reader thread parses to choose a class. A larger body is a review's
/// acceptances or a rule document, which are bulk, and is parsed on the thread that runs it.
const PARSED_ON_READ: usize = 64 * 1024;

/// Sizes the shared pool bulk requests run on to the machine's cores less the interactive
/// threads, unless `RAYON_NUM_THREADS` sizes it. Call it once, before the session starts.
pub fn size_shared_pool() {
    if std::env::var_os("RAYON_NUM_THREADS").is_some() {
        return;
    }
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    // A pool another caller built first keeps its size.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(cores.saturating_sub(INTERACTIVE_THREADS).max(1))
        .build_global();
}

fn relock<T>(result: std::sync::LockResult<T>) -> T {
    result.unwrap_or_else(PoisonError::into_inner)
}

/// Encoded frames waiting for the writer. It sends a waiting interactive frame before any bulk
/// one, so a keystroke's answer waits for at most the frame already on the pipe.
#[derive(Default)]
struct Outbox {
    queues: Mutex<Queues>,
    ready: Condvar,
}
#[derive(Default)]
struct Queues {
    interactive: VecDeque<Vec<u8>>,
    bulk: VecDeque<Vec<u8>>,
    closed: bool,
}
impl Outbox {
    fn push(&self, class: Class, frame: Vec<u8>) {
        let mut queues = relock(self.queues.lock());
        if queues.closed {
            return;
        }
        match class {
            Class::Interactive => queues.interactive.push_back(frame),
            Class::Bulk => queues.bulk.push_back(frame),
        }
        self.ready.notify_one();
    }
    fn close(&self) {
        relock(self.queues.lock()).closed = true;
        self.ready.notify_all();
    }
    /// The next frame to send and whether more are waiting; `None` once closed and drained.
    fn next(&self) -> Option<(Vec<u8>, bool)> {
        let mut queues = relock(self.queues.lock());
        loop {
            if let Some(frame) = queues.interactive.pop_front() {
                let more = !queues.interactive.is_empty() || !queues.bulk.is_empty();
                return Some((frame, more));
            }
            if let Some(frame) = queues.bulk.pop_front() {
                return Some((frame, !queues.bulk.is_empty()));
            }
            if queues.closed {
                return None;
            }
            queues = relock(self.ready.wait(queues));
        }
    }
}

fn write_frames(outbox: &Outbox, mut output: impl Write) -> io::Result<()> {
    let written = (|| {
        while let Some((frame, more)) = outbox.next() {
            output.write_all(&frame)?;
            if !more {
                output.flush()?;
            }
        }
        output.flush()
    })();
    // A host that stopped reading gets no more frames; requests still running drop theirs.
    outbox.close();
    written
}

/// A request's cancel token and the batches it sent that the host hasn't consumed.
#[derive(Default)]
struct Flow {
    cancelled: AtomicBool,
    window: Mutex<Window>,
    changed: Condvar,
}
#[derive(Default)]
struct Window {
    unconsumed: u32,
    /// The host's input ended, so it sends no more credits; it reads what is left.
    released: bool,
}
impl Flow {
    /// Takes a place in the window for one batch, waiting while it is full, and returns how long
    /// that took. A request cancelled meanwhile stops there.
    fn take(&self) -> Result<Duration> {
        let started = Instant::now();
        let mut window = relock(self.window.lock());
        while window.unconsumed >= WINDOW && !window.released {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(
                    ErrorCode::Cancelled,
                    "The request was cancelled.",
                ));
            }
            window = relock(self.changed.wait_timeout(window, Duration::from_millis(50))).0;
        }
        window.unconsumed += 1;
        Ok(started.elapsed())
    }
    fn credit(&self, frames: u32) {
        let mut window = relock(self.window.lock());
        window.unconsumed = window.unconsumed.saturating_sub(frames);
        self.changed.notify_all();
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let _window = relock(self.window.lock());
        self.changed.notify_all();
    }
    fn release(&self) {
        relock(self.window.lock()).released = true;
        self.changed.notify_all();
    }
}

/// Requests in flight, each with its flow.
#[derive(Default)]
struct Live {
    requests: Mutex<HashMap<u32, Arc<Flow>>>,
    idle: Condvar,
}
impl Live {
    fn start(&self, id: u32) -> Arc<Flow> {
        let flow = Arc::new(Flow::default());
        relock(self.requests.lock()).insert(id, Arc::clone(&flow));
        flow
    }
    fn cancel(&self, id: u32) {
        if let Some(flow) = relock(self.requests.lock()).get(&id) {
            flow.cancel();
        }
    }
    fn credit(&self, id: u32, frames: u32) {
        if let Some(flow) = relock(self.requests.lock()).get(&id) {
            flow.credit(frames);
        }
    }
    /// Stops pacing every request once the host can send no more credits.
    fn release(&self) {
        for flow in relock(self.requests.lock()).values() {
            flow.release();
        }
    }
    fn finish(&self, id: u32) {
        let mut requests = relock(self.requests.lock());
        requests.remove(&id);
        if requests.is_empty() {
            self.idle.notify_all();
        }
    }
    fn wait_idle(&self) {
        let mut requests = relock(self.requests.lock());
        while !requests.is_empty() {
            requests = relock(self.idle.wait(requests));
        }
    }
}

#[derive(Default)]
struct Shared {
    session: EngineSession,
    outbox: Outbox,
    live: Live,
}

/// What a request frame asks for.
enum Work {
    Request(Result<EngineRequest>),
    /// A body too large to parse on the reader thread.
    Body(Vec<u8>),
    #[cfg(any(test, debug_assertions, feature = "engine-probes"))]
    Probe(probe::Probe),
}
impl Work {
    fn read(body: Vec<u8>) -> Self {
        #[cfg(any(test, debug_assertions, feature = "engine-probes"))]
        if let Some(probe) = probe::read(&body) {
            return Self::Probe(probe);
        }
        if body.len() <= PARSED_ON_READ {
            Self::Request(request(&body))
        } else {
            Self::Body(body)
        }
    }
    fn class(&self) -> Class {
        match self {
            Self::Request(Ok(request)) => Class::of(request),
            #[cfg(any(test, debug_assertions, feature = "engine-probes"))]
            Self::Probe(probe) => probe.class(),
            _ => Class::Bulk,
        }
    }
    fn run(
        self,
        session: &EngineSession,
        cancelled: &AtomicBool,
        reply: &mut dyn Reply,
    ) -> Result<Profile> {
        let parsed = match self {
            Self::Request(parsed) => parsed?,
            Self::Body(body) => request(&body)?,
            #[cfg(any(test, debug_assertions, feature = "engine-probes"))]
            Self::Probe(probe) => return probe.run(cancelled, reply),
        };
        session.answer(&parsed, cancelled, reply)
    }
}

struct Job {
    id: u32,
    class: Class,
    work: Work,
    flow: Arc<Flow>,
}

/// A request's answer as it goes out: each part and batch is queued for the writer as soon as
/// the engine produces it, and batches wait for the host to consume earlier ones.
struct Outgoing<'a> {
    shared: &'a Shared,
    class: Class,
    id: u32,
    flow: &'a Flow,
    batches: u32,
    batch_bytes: u64,
    stalled: Duration,
}
impl Reply for Outgoing<'_> {
    fn part(&mut self, body: Vec<u8>) -> Result<()> {
        self.shared
            .outbox
            .push(self.class, frame(Kind::Part, 0, self.id, &body));
        Ok(())
    }
    fn batch(&mut self, body: Vec<u8>) -> Result<()> {
        self.stalled += self.flow.take()?;
        self.batches += 1;
        self.batch_bytes += body.len() as u64;
        self.shared
            .outbox
            .push(self.class, frame(Kind::Batch, 0, self.id, &body));
        Ok(())
    }
}

fn encoded(kind: Kind, id: u32, body: &impl Serialize) -> Vec<u8> {
    let body = serde_json::to_vec(body);
    let (kind, body) = match &body {
        Ok(body) if body.len() <= MAX_BODY => (kind, body.as_slice()),
        _ => (Kind::Error, ENCODING_FAILED),
    };
    frame(kind, LAST, id, body)
}

fn frame(kind: Kind, flags: u8, id: u32, body: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&[kind as u8, flags, 0, 0]);
    frame.extend_from_slice(&id.to_le_bytes());
    frame.extend_from_slice(body);
    frame
}

fn failure(id: u32, code: ErrorCode, message: String) -> Vec<u8> {
    let failure = EngineFailure {
        error: EngineError {
            code: code.as_str(),
            message,
        },
        profile: Profile::now(),
    };
    encoded(Kind::Error, id, &failure)
}

/// Runs one request and queues its frames. A panic is contained to the request: shared state is
/// immutable or behind locks that don't poison, so the session goes on.
fn run(shared: &Shared, job: Job) {
    let Job {
        id,
        class,
        work,
        flow,
    } = job;
    let mut outgoing = Outgoing {
        shared,
        class,
        id,
        flow: &flow,
        batches: 0,
        batch_bytes: 0,
        stalled: Duration::ZERO,
    };
    let answered = std::panic::catch_unwind(AssertUnwindSafe(|| {
        work.run(&shared.session, &flow.cancelled, &mut outgoing)
    }));
    let counted = |profile: Profile| Profile {
        batches: outgoing.batches,
        batch_bytes: outgoing.batch_bytes,
        credit_stall_ms: outgoing.stalled.as_secs_f64() * 1000.0,
        ..profile
    };
    let terminal = match answered {
        Ok(Ok(profile)) => encoded(
            Kind::End,
            id,
            &EngineEnd {
                profile: counted(profile),
            },
        ),
        Ok(Err(error))
            if error.code == ErrorCode::Cancelled && flow.cancelled.load(Ordering::Relaxed) =>
        {
            encoded(
                Kind::Cancelled,
                id,
                &EngineEnd {
                    profile: counted(Profile::now()),
                },
            )
        }
        Ok(Err(error)) => failure(id, error.code, error.to_string()),
        Err(_) => failure(
            id,
            ErrorCode::Internal,
            "The engine failed while answering this request; the session continues.".into(),
        ),
    };
    // Queued before the request leaves the live set, so a session that ends waits for it.
    shared.outbox.push(class, terminal);
    shared.live.finish(id);
}

/// Serves one host until its input ends: requests run concurrently in their classes, and the
/// session ends once the requests in flight have answered.
pub fn serve(mut input: impl Read, output: impl Write + Send) -> Result<()> {
    let shared = Arc::new(Shared::default());
    let interactive = rayon::ThreadPoolBuilder::new()
        .num_threads(INTERACTIVE_THREADS)
        .thread_name(|index| format!("game-text-interactive-{index}"))
        .build()
        .map_err(|source| {
            Error::with_source(
                ErrorCode::Unavailable,
                "The interactive threads did not start.",
                source,
            )
        })?;
    let (bulk, queue) = mpsc::channel::<Job>();
    let queue = Mutex::new(queue);
    std::thread::scope(|scope| -> Result<()> {
        let writer = scope.spawn(|| write_frames(&shared.outbox, output));
        for _ in 0..BULK_REQUESTS {
            scope.spawn(|| {
                loop {
                    // The receiver's lock is held only while one thread waits for the next job,
                    // not while it runs one.
                    let next = relock(queue.lock()).recv();
                    let Ok(job) = next else { break };
                    run(&shared, job);
                }
            });
        }
        let read = (|| -> Result<()> {
            while let Some(frame) = read_frame(&mut input)? {
                match frame.kind {
                    Kind::Request => {
                        let id = frame.request;
                        let work = Work::read(frame.body);
                        let class = work.class();
                        let job = Job {
                            id,
                            class,
                            work,
                            flow: shared.live.start(id),
                        };
                        match class {
                            Class::Interactive => {
                                let shared = Arc::clone(&shared);
                                interactive.spawn_fifo(move || run(&shared, job));
                            }
                            Class::Bulk => {
                                if let Err(mpsc::SendError(job)) = bulk.send(job) {
                                    run(&shared, job);
                                }
                            }
                        }
                    }
                    Kind::Cancel => shared.live.cancel(frame.request),
                    Kind::Credit => {
                        let credit: Credit =
                            serde_json::from_slice(&frame.body).map_err(|source| {
                                Error::with_source(
                                    ErrorCode::InvalidInput,
                                    "Invalid credit frame.",
                                    source,
                                )
                            })?;
                        shared.live.credit(frame.request, credit.frames);
                    }
                    _ => {
                        return Err(Error::new(
                            ErrorCode::InvalidInput,
                            "The host sent an engine frame.",
                        ));
                    }
                }
            }
            Ok(())
        })();
        drop(bulk);
        // The host sends no more credits; requests still streaming send what is left.
        shared.live.release();
        shared.live.wait_idle();
        shared.outbox.close();
        let written = writer.join();
        read?;
        match written {
            Ok(written) => Ok(written?),
            Err(_) => Err(Error::new(
                ErrorCode::Internal,
                "The engine's frame writer failed.",
            )),
        }
    })
}

/// Requests that drive the session's failure paths, in tests, debug builds and probe builds:
/// `{"action":"probe","probe":"hold"|"panic"|"abort"|"stream","bulk":true,"batches":n}`.
#[cfg(any(test, debug_assertions, feature = "engine-probes"))]
mod probe {
    use super::Class;
    use crate::Result;
    use crate::engine::{Profile, Reply};
    use serde::Deserialize;
    use std::sync::atomic::AtomicBool;

    #[derive(Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum Kind {
        /// Runs until cancelled.
        Hold,
        /// Sends one-row batches as fast as the host consumes them, until cancelled or done.
        Stream,
        Panic,
        /// Ends the process, as a crash would.
        Abort,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct Probe {
        action: String,
        probe: Kind,
        #[serde(default)]
        bulk: bool,
        /// How many batches `stream` sends before it ends; none sends until cancelled.
        #[serde(default)]
        batches: Option<u32>,
    }

    pub(super) fn read(body: &[u8]) -> Option<Probe> {
        serde_json::from_slice::<Probe>(body)
            .ok()
            .filter(|probe| probe.action == "probe")
    }

    impl Probe {
        pub(super) fn class(&self) -> Class {
            if self.bulk {
                Class::Bulk
            } else {
                Class::Interactive
            }
        }
        #[expect(
            clippy::panic,
            reason = "the probe exists to show that a panic stays inside its request"
        )]
        pub(super) fn run(&self, cancelled: &AtomicBool, reply: &mut dyn Reply) -> Result<Profile> {
            match self.probe {
                Kind::Stream => {
                    let mut rows = crate::batch::Batches::new(
                        &crate::batch::PACKAGE,
                        "packages",
                        crate::batch::PACKAGE.all(),
                    );
                    for _ in 0..self.batches.unwrap_or(u32::MAX) {
                        crate::engine_match::checkpoint(cancelled)?;
                        rows.push(
                            &serde_json::json!({"packageFile": "Probe", "status": "complete"}),
                        )?;
                        rows.flush(reply)?;
                    }
                    Ok(Profile::now())
                }
                Kind::Hold => loop {
                    crate::engine_match::checkpoint(cancelled)?;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                },
                Kind::Panic => panic!("Probe panic."),
                Kind::Abort => std::process::abort(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::time::{Duration, Instant};

    /// The host's end of a session that runs on another thread.
    struct Host {
        send: Option<mpsc::Sender<Vec<u8>>>,
        output: Arc<Mutex<Vec<u8>>>,
        session: Option<std::thread::JoinHandle<Result<()>>>,
    }
    /// The engine's input: chunks the host sends, until it closes.
    struct Pipe {
        chunks: mpsc::Receiver<Vec<u8>>,
        unread: VecDeque<u8>,
    }
    impl Read for Pipe {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.unread.is_empty() {
                match self.chunks.recv() {
                    Ok(chunk) => self.unread.extend(chunk),
                    Err(_) => return Ok(0),
                }
            }
            let count = buffer.len().min(self.unread.len());
            for (slot, byte) in buffer.iter_mut().zip(self.unread.drain(..count)) {
                *slot = byte;
            }
            Ok(count)
        }
    }
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            relock(self.0.lock()).extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Host {
        fn start() -> Self {
            let (send, chunks) = mpsc::channel();
            let output = Arc::new(Mutex::new(Vec::new()));
            let writer = Shared(Arc::clone(&output));
            let session = std::thread::spawn(move || {
                serve(
                    Pipe {
                        chunks,
                        unread: VecDeque::new(),
                    },
                    writer,
                )
            });
            Self {
                send: Some(send),
                output,
                session: Some(session),
            }
        }
        fn send(&self, kind: Kind, id: u32, body: Value) {
            let body = if body.is_null() {
                Vec::new()
            } else {
                body.to_string().into_bytes()
            };
            let mut frame = Vec::new();
            write_frame(&mut frame, kind, 0, id, &body).unwrap();
            self.send.as_ref().unwrap().send(frame).unwrap();
        }
        /// The frames sent so far for request `id`.
        fn answered(&self, id: u32) -> Vec<Frame> {
            frames(&relock(self.output.lock()))
                .into_iter()
                .filter(|frame| frame.request == id)
                .collect()
        }
        /// Waits for request `id`'s terminal frame.
        fn terminal(&self, id: u32) -> Frame {
            let started = Instant::now();
            loop {
                if let Some(frame) = self
                    .answered(id)
                    .into_iter()
                    .find(|frame| frame.flags & LAST != 0)
                {
                    return frame;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "no answer to {id}"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        fn close(mut self) -> Result<()> {
            drop(self.send.take());
            self.session.take().unwrap().join().unwrap()
        }
    }

    fn frames(mut bytes: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        while let Some(frame) = read_frame(&mut bytes).unwrap() {
            frames.push(frame);
        }
        frames
    }

    fn requests(requests: &[(u32, Value)]) -> Vec<u8> {
        let mut input = Vec::new();
        for (id, request) in requests {
            write_frame(
                &mut input,
                Kind::Request,
                0,
                *id,
                request.to_string().as_bytes(),
            )
            .unwrap();
        }
        input
    }

    #[test]
    fn answers_each_request_by_its_id_and_survives_a_failed_one() -> Result<()> {
        let input = requests(&[
            (7, json!({"action":"capabilities"})),
            (9, json!({"action":"summary","reader":"missing"})),
            (11, json!({"action":"retired"})),
            (12, json!({"action":"capabilities"})),
        ]);
        let mut output = Vec::new();
        serve(input.as_slice(), &mut output)?;
        let frames = frames(&output);
        // Requests run concurrently, so only each request's own frames keep their order.
        let answered = |id: u32| {
            frames
                .iter()
                .filter(|frame| frame.request == id)
                .map(|frame| (frame.kind, frame.flags))
                .collect::<Vec<_>>()
        };
        for id in [7, 12] {
            assert_eq!(answered(id), [(Kind::Part, 0), (Kind::End, LAST)]);
        }
        for id in [9, 11] {
            assert_eq!(answered(id), [(Kind::Error, LAST)]);
        }
        let body = |id: u32| -> Result<Value> {
            let frame = frames
                .iter()
                .find(|frame| frame.request == id)
                .ok_or("Missing frame.")?;
            Ok(serde_json::from_slice(&frame.body)?)
        };
        assert_eq!(body(7)?, serde_json::to_value(crate::contract::identity())?);
        assert_eq!(body(9)?["error"]["code"], "not_found");
        assert_eq!(body(11)?["error"]["code"], "invalid_input");
        Ok(())
    }

    #[test]
    fn a_keystroke_answers_while_bulk_work_runs_and_cancel_stops_it() -> Result<()> {
        let host = Host::start();
        host.send(
            Kind::Request,
            1,
            json!({"action":"probe","probe":"hold","bulk":true}),
        );
        host.send(
            Kind::Request,
            2,
            json!({"action":"probe","probe":"hold","bulk":true}),
        );
        // Both bulk slots are busy; an interactive request still answers.
        host.send(Kind::Request, 3, json!({"action":"capabilities"}));
        assert_eq!(host.terminal(3).kind, Kind::End);
        assert!(host.answered(1).is_empty() && host.answered(2).is_empty());
        // A third bulk request waits for a slot, and cancelling a held one frees it.
        host.send(Kind::Request, 4, json!({"action":"retired"}));
        std::thread::sleep(Duration::from_millis(20));
        assert!(host.answered(4).is_empty());
        host.send(Kind::Cancel, 1, Value::Null);
        assert_eq!(host.terminal(1).kind, Kind::Cancelled);
        assert_eq!(host.terminal(4).kind, Kind::Error);
        // A cancel for a request that already ended changes nothing.
        host.send(Kind::Cancel, 3, Value::Null);
        host.send(Kind::Cancel, 2, Value::Null);
        assert_eq!(host.terminal(2).kind, Kind::Cancelled);
        host.close()
    }

    #[test]
    fn a_stream_waits_for_credits_and_stops_when_cancelled_while_waiting() -> Result<()> {
        let host = Host::start();
        let batches = |host: &Host| {
            host.answered(5)
                .iter()
                .filter(|frame| frame.kind == Kind::Batch)
                .count()
        };
        let settled = |host: &Host, count: usize| {
            let started = Instant::now();
            while batches(host) < count {
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "{count} batches"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            // The window is full: nothing more comes until the host consumes some.
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(batches(host), count);
        };
        host.send(
            Kind::Request,
            5,
            json!({"action":"probe","probe":"stream","bulk":true}),
        );
        settled(&host, WINDOW as usize);
        host.send(Kind::Credit, 5, json!({"frames": 3}));
        settled(&host, WINDOW as usize + 3);
        let (header, rows) = crate::batch::read(&host.answered(5)[0].body)?;
        assert_eq!(header, "packages");
        assert_eq!(
            rows,
            [json!({"packageFile": "Probe", "status": "complete"})]
        );
        // A request waiting for credits still answers its cancel.
        host.send(Kind::Cancel, 5, Value::Null);
        assert_eq!(host.terminal(5).kind, Kind::Cancelled);
        host.close()
    }

    #[test]
    fn a_panic_fails_only_its_request() -> Result<()> {
        let host = Host::start();
        host.send(Kind::Request, 1, json!({"action":"probe","probe":"panic"}));
        let failed = host.terminal(1);
        assert_eq!(failed.kind, Kind::Error);
        let body: Value = serde_json::from_slice(&failed.body)?;
        assert_eq!(body["error"]["code"], "internal");
        host.send(Kind::Request, 2, json!({"action":"capabilities"}));
        assert_eq!(host.terminal(2).kind, Kind::End);
        host.close()
    }

    #[test]
    fn the_writer_sends_waiting_interactive_frames_first() {
        let outbox = Outbox::default();
        outbox.push(Class::Bulk, vec![1]);
        outbox.push(Class::Bulk, vec![2]);
        outbox.push(Class::Interactive, vec![3]);
        outbox.close();
        let order =
            std::iter::from_fn(|| outbox.next().map(|(frame, _)| frame[0])).collect::<Vec<_>>();
        assert_eq!(order, [3, 1, 2]);
    }

    #[test]
    fn reads_lone_utf16_units_in_a_request_body() -> Result<()> {
        // JSON.stringify spells a lone surrogate as an escape; the rule IR arrives inline.
        let body = br#"{"action":"rules_check","rules":{"schemaVersion":4,"roles":[],"rules":[{"id":"\ud800"}]}}"#;
        let EngineRequest::RulesCheck { rules } = request(body)? else {
            return Err("Expected a rules check.".into());
        };
        assert_eq!(
            crate::wtf8::view_json(&rules["rules"][0]["id"])?,
            r#""\ud800""#
        );
        Ok(())
    }

    #[test]
    fn a_malformed_frame_ends_the_session() {
        let mut header = [0; HEADER];
        header[4] = 99;
        assert!(serve(header.as_slice(), Vec::new()).is_err());
        header[4] = Kind::Request as u8;
        header[0..4].copy_from_slice(&((MAX_BODY + 1) as u32).to_le_bytes());
        assert!(serve(header.as_slice(), Vec::new()).is_err());
        // A header cut short is a defect; input ending between frames is not.
        assert!(serve(&header[..5], Vec::new()).is_err());
        assert!(serve([].as_slice(), Vec::new()).is_ok());
        // The host never sends the engine's frames.
        let mut end = Vec::new();
        write_frame(&mut end, Kind::End, LAST, 1, b"{}").unwrap();
        assert!(serve(end.as_slice(), Vec::new()).is_err());
    }
}
