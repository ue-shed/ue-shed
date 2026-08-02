use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;
use uasset_io::protocol::{Event, decode_event};

fn run_request(request: Value) -> (bool, Vec<Value>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_uasset"))
        .arg("protocol")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("uasset protocol process starts");
    let input = serde_json::to_vec(&request).expect("request serializes");
    child
        .stdin
        .take()
        .expect("protocol stdin")
        .write_all(&input)
        .expect("request writes");
    let output = child.wait_with_output().expect("protocol process exits");
    let events = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("protocol line is JSON"))
        .collect();
    (
        output.status.success(),
        events,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn base_request(operation: Value) -> Value {
    serde_json::json!({
        "contract": { "name": "uasset-io", "version": { "major": 1, "minor": 0 } },
        "limits": { "concurrency": 1 },
        "operation": operation,
        "requestId": "process-test"
    })
}

#[test]
fn protocol_process_emits_a_typed_inspection_stream() {
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset");
    let request = base_request(serde_json::json!({
        "kind": "inspect",
        "assetPath": fixture.to_string_lossy()
    }));
    let (success, events, stderr) = run_request(request);
    assert!(success, "protocol failed: {stderr}");
    assert_eq!(events.len(), 3);
    for event in &events {
        let decoded = decode_event(serde_json::to_string(event).unwrap().as_bytes())
            .expect("Rust validates every emitted event");
        assert_eq!(event["requestId"], "process-test");
        assert_eq!(event["sequence"], decoded_sequence(&decoded));
    }
    assert_eq!(events[0]["kind"], "accepted");
    assert_eq!(events[1]["kind"], "result");
    assert_eq!(events[1]["result"]["kind"], "inspect");
    assert_eq!(events[2]["kind"], "completed");
}

#[test]
fn explicit_empty_paths_do_not_scan_content() {
    let project_root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project");
    let request = base_request(serde_json::json!({
        "kind": "scan",
        "depth": "full",
        "paths": [],
        "projectRoot": project_root.to_string_lossy()
    }));
    let (success, events, stderr) = run_request(request);
    assert!(success, "protocol failed: {stderr}");
    assert_eq!(events[0]["kind"], "accepted");
    assert_eq!(events[1]["result"]["kind"], "scan_summary");
    assert_eq!(events[1]["result"]["summary"]["scannedAssets"], 0);
    assert_eq!(events.last().unwrap()["kind"], "completed");
}

#[test]
fn protocol_process_emits_typed_results_for_authoring_and_projections() {
    let fixture_root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project");
    let authoring = fixture_root.join("Content/Fixture/Authoring/DT_Scalars.uasset");
    let texture =
        fixture_root.join("Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset");
    for (operation, expected_result) in [
        (
            serde_json::json!({
                "kind": "authoring",
                "assetPath": authoring.to_string_lossy()
            }),
            "authoring",
        ),
        (
            serde_json::json!({
                "kind": "extract_text",
                "projectRoot": fixture_root.to_string_lossy()
            }),
            "extract_text",
        ),
        (
            serde_json::json!({
                "kind": "extract_texture",
                "paths": [texture.to_string_lossy()],
                "projectRoot": fixture_root.to_string_lossy()
            }),
            "extract_texture",
        ),
    ] {
        let (success, events, stderr) = run_request(base_request(operation));
        assert!(success, "protocol failed: {stderr}");
        assert_eq!(
            events.first().and_then(|event| event.get("kind")),
            Some(&serde_json::json!("accepted"))
        );
        assert!(events.iter().any(|event| {
            event.get("kind") == Some(&serde_json::json!("result"))
                && event.get("result").and_then(|result| result.get("kind"))
                    == Some(&serde_json::json!(expected_result))
        }));
        assert_eq!(
            events.last().and_then(|event| event.get("kind")),
            Some(&serde_json::json!("completed"))
        );
        for event in events {
            decode_event(serde_json::to_string(&event).unwrap().as_bytes())
                .expect("Rust validates every emitted event");
        }
    }
}

#[test]
fn protocol_process_can_be_closed_before_worker_finishes() {
    let project_root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project");
    let mut child = Command::new(env!("CARGO_BIN_EXE_uasset"))
        .arg("protocol")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("uasset protocol process starts");
    let request = base_request(serde_json::json!({
        "kind": "scan",
        "depth": "full",
        "projectRoot": project_root.to_string_lossy()
    }));
    child
        .stdin
        .take()
        .expect("protocol stdin")
        .write_all(&serde_json::to_vec(&request).unwrap())
        .expect("request writes");
    let mut first_line = String::new();
    BufReader::new(child.stdout.take().expect("protocol stdout"))
        .read_line(&mut first_line)
        .expect("accepted event is readable");
    assert!(first_line.contains("\"kind\":\"accepted\""));
    child.kill().expect("protocol process can be interrupted");
    let status = child.wait().expect("interrupted protocol process exits");
    assert!(!status.success());
}

#[test]
fn protocol_process_emits_a_typed_failure_for_broken_worker_output() {
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset");
    let mut request = base_request(serde_json::json!({
        "kind": "inspect",
        "assetPath": fixture.to_string_lossy()
    }));
    request["limits"]["maximumOutputBytes"] = serde_json::json!(1);
    let (success, events, stderr) = run_request(request);
    assert!(
        success,
        "protocol framing failure should be typed: {stderr}"
    );
    assert_eq!(events[0]["kind"], "accepted");
    assert_eq!(events.last().unwrap()["kind"], "failed");
    assert_eq!(events.last().unwrap()["code"], "output_limit");
}

#[test]
fn protocol_process_reports_partial_package_failures_as_typed_events() {
    let project_root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project");
    let path = project_root.join(format!(
        ".ue-shed-uasset-protocol-invalid-{}.uasset",
        std::process::id()
    ));
    std::fs::write(&path, [0_u8, 1, 2]).expect("temporary invalid package writes");
    let request = base_request(serde_json::json!({
        "kind": "scan",
        "depth": "full",
        "paths": [path.to_string_lossy()],
        "projectRoot": project_root.to_string_lossy()
    }));
    let (success, events, stderr) = run_request(request);
    let _ = std::fs::remove_file(path);
    assert!(
        success,
        "partial scan should complete through the protocol: {stderr}"
    );
    assert!(events.iter().any(|event| event["kind"] == "diagnostic"));
    assert_eq!(events.last().unwrap()["kind"], "completed");
    assert_eq!(events.last().unwrap()["outcome"], "partial");
}

#[test]
fn invalid_request_fails_before_starting_work() {
    let request = serde_json::json!({
        "contract": { "name": "uasset-io", "version": { "major": 2, "minor": 0 } },
        "limits": {},
        "operation": { "kind": "inspect", "assetPath": "missing.uasset" },
        "requestId": "invalid-test"
    });
    let (success, events, stderr) = run_request(request);
    assert!(!success);
    assert!(events.is_empty());
    assert!(stderr.contains("unsupported contract major"));
}

fn decoded_sequence(event: &Event) -> u64 {
    match event {
        Event::Accepted { fields, .. }
        | Event::Progress { fields, .. }
        | Event::Diagnostic { fields, .. }
        | Event::Completed { fields, .. }
        | Event::Failed { fields, .. }
        | Event::Rejected { fields, .. }
        | Event::Result { fields, .. } => fields.sequence,
    }
}
