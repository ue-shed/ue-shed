//! The engine's binary session, `uasset game-text-engine`.
//!
//! Every message is one frame: a 12-byte little-endian header (body length, kind, flags, two
//! reserved bytes and the host's request ID) and its body. Requests and replies are JSON with the
//! contract's generated types; the request body is read WTF-8-aware, so lone UTF-16 units and the
//! rule IR travel inline. After the handshake neither side checks the other's frames: a malformed
//! one is a defect, and the session ends.
use crate::engine::{EngineRequest, EngineSession, Profile};
use crate::{Error, ErrorCode, Result};
use serde::Serialize;
use std::io::{self, Read, Write};
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use ts_rs::TS;

/// Header bytes before each body.
pub const HEADER: usize = 12;
/// The largest body a frame carries, in either direction.
pub const MAX_BODY: usize = 8 << 20;
/// `flags` bit 0: the request's last frame.
pub const LAST: u8 = 1;

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
            type = "\"busy\" | \"cancelled\" | \"invalid_input\" | \"invalid_cache\" | \"limit_exceeded\" | \"stale_generation\" | \"unavailable\" | \"not_found\" | \"io_error\""
        )
    )]
    pub code: &'static str,
    pub message: String,
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

fn json(value: &impl Serialize) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}

/// Reads a request body: JSON text, its strings read as reversible views.
fn request(body: &[u8]) -> Result<EngineRequest> {
    let text = std::str::from_utf8(body).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "A request is not UTF-8.", source)
    })?;
    crate::json_value::parse_as(text).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid engine request.", source)
    })
}

/// Serves one host until its input ends. Requests run one at a time, in order.
pub fn serve(mut input: impl Read, mut output: impl Write) -> Result<()> {
    let mut session = EngineSession::default();
    let cancelled = AtomicBool::new(false);
    while let Some(frame) = read_frame(&mut input)? {
        match frame.kind {
            Kind::Request => {
                let id = frame.request;
                match request(&frame.body).and_then(|request| session.execute(&request, &cancelled))
                {
                    Ok(answer) => {
                        if let Some(part) = answer.part {
                            write_frame(&mut output, Kind::Part, 0, id, part.as_bytes())?;
                        }
                        let end = EngineEnd {
                            profile: answer.profile,
                        };
                        write_frame(&mut output, Kind::End, LAST, id, &json(&end)?)?;
                    }
                    Err(error) => {
                        let failure = EngineFailure {
                            error: EngineError {
                                code: error.code.as_str(),
                                message: error.to_string(),
                            },
                            profile: Profile::now(),
                        };
                        write_frame(&mut output, Kind::Error, LAST, id, &json(&failure)?)?;
                    }
                }
                output.flush()?;
            }
            // A request runs to its end before the next frame is read, so a cancel or credit
            // always names a request that has ended.
            Kind::Cancel | Kind::Credit => {}
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    "The host sent an engine frame.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

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
        let answered = frames(&output)
            .into_iter()
            .map(|frame| (frame.request, frame.kind, frame.flags))
            .collect::<Vec<_>>();
        assert_eq!(
            answered,
            [
                (7, Kind::Part, 0),
                (7, Kind::End, LAST),
                (9, Kind::Error, LAST),
                (11, Kind::Error, LAST),
                (12, Kind::Part, 0),
                (12, Kind::End, LAST),
            ]
        );
        let frames = frames(&output);
        let contract: Value = serde_json::from_slice(&frames[0].body)?;
        assert_eq!(contract, serde_json::to_value(crate::contract::identity())?);
        let failed: Value = serde_json::from_slice(&frames[2].body)?;
        assert_eq!(failed["error"]["code"], "not_found");
        let invalid: Value = serde_json::from_slice(&frames[3].body)?;
        assert_eq!(invalid["error"]["code"], "invalid_input");
        Ok(())
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
