use std::ffi::OsString;
use std::path::PathBuf;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Eq, PartialEq)]
pub struct LaunchRequest {
    pub arguments: Vec<OsString>,
    pub cwd: PathBuf,
    pub executable: OsString,
}

pub fn parse_launch_request(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<LaunchRequest, String> {
    let mut arguments = arguments.into_iter();
    let Some(flag) = arguments.next() else {
        return Err(
            "usage: ue-shed-process-supervisor --cwd <directory> -- <executable> [args...]".into(),
        );
    };
    if flag != "--cwd" {
        return Err("the first supervisor argument must be --cwd".into());
    }
    let cwd = arguments
        .next()
        .ok_or_else(|| "--cwd requires a directory".to_owned())?;
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
        return Err("the supervised command must follow --".into());
    }
    let executable = arguments
        .next()
        .ok_or_else(|| "the supervised executable is required".to_owned())?;
    Ok(LaunchRequest {
        arguments: arguments.collect(),
        cwd: PathBuf::from(cwd),
        executable,
    })
}

#[cfg(windows)]
pub mod windows {
    use super::LaunchRequest;
    use std::ffi::{OsStr, c_void};
    use std::io::{self, Read, Write};
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use std::thread;
    use windows_sys::Win32::Foundation::{
        CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectAssociateCompletionPortInformation, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO;
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, INFINITE,
        PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
    };

    const SUPERVISOR_TERMINATION_EXIT_CODE: u32 = 0xe000_0001;
    const JOB_COMPLETION_KEY: usize = 1;

    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE, operation: &str) -> io::Result<Self> {
            if handle.is_null() {
                let error = io::Error::last_os_error();
                Err(io::Error::new(
                    error.kind(),
                    format!("{operation}: {error}"),
                ))
            } else {
                Ok(Self(handle))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: OwnedHandle is constructed only for a non-null owned Win32 handle and drops once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn wide_null(value: &OsStr, label: &str) -> Result<Vec<u16>, String> {
        let mut wide = value.encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            return Err(format!("{label} contains an embedded null"));
        }
        wide.push(0);
        Ok(wide)
    }

    fn quote_argument(value: &OsStr) -> Result<Vec<u16>, String> {
        let wide = value.encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            return Err("a command argument contains an embedded null".into());
        }
        let needs_quotes = wide.is_empty()
            || wide.iter().any(|character| {
                matches!(*character, 0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0x22)
            });
        if !needs_quotes {
            return Ok(wide);
        }
        let mut quoted = vec![u16::from(b'"')];
        let mut backslashes = 0usize;
        for character in wide {
            if character == u16::from(b'\\') {
                backslashes += 1;
                continue;
            }
            if character == u16::from(b'"') {
                quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2 + 1));
                quoted.push(character);
            } else {
                quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
                quoted.push(character);
            }
            backslashes = 0;
        }
        quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2));
        quoted.push(u16::from(b'"'));
        Ok(quoted)
    }

    fn command_line(request: &LaunchRequest) -> Result<Vec<u16>, String> {
        let mut command = Vec::new();
        for (index, argument) in std::iter::once(&request.executable)
            .chain(request.arguments.iter())
            .enumerate()
        {
            if index > 0 {
                command.push(u16::from(b' '));
            }
            command.extend(quote_argument(argument)?);
        }
        command.push(0);
        if command.len() > 32_767 {
            return Err("the Windows command line exceeds 32,766 UTF-16 code units".into());
        }
        Ok(command)
    }

    fn win32_result(result: i32, operation: &str) -> io::Result<()> {
        if result == 0 {
            let error = io::Error::last_os_error();
            Err(io::Error::new(
                error.kind(),
                format!("{operation}: {error}"),
            ))
        } else {
            Ok(())
        }
    }

    pub fn run(request: LaunchRequest) -> Result<(), String> {
        let executable = wide_null(&request.executable, "the executable path")?;
        let cwd = wide_null(request.cwd.as_os_str(), "the working directory")?;
        let mut command = command_line(&request)?;

        // SAFETY: null security/name pointers request a private Job Object with default security.
        let job = OwnedHandle::new(
            unsafe { CreateJobObjectW(null(), null()) },
            "CreateJobObjectW",
        )
        .map_err(|error| error.to_string())?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: limits points to the documented structure and remains valid for the call.
        win32_result(
            unsafe {
                SetInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            },
            "SetInformationJobObject",
        )
        .map_err(|error| error.to_string())?;

        // SAFETY: INVALID_HANDLE_VALUE requests a new private completion port.
        let completion_port = OwnedHandle::new(
            unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) },
            "CreateIoCompletionPort",
        )
        .map_err(|error| error.to_string())?;
        let completion_association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: JOB_COMPLETION_KEY as *mut c_void,
            CompletionPort: completion_port.raw(),
        };
        // SAFETY: the association points to a live completion port and remains valid for the call.
        win32_result(
            unsafe {
                SetInformationJobObject(
                    job.raw(),
                    JobObjectAssociateCompletionPortInformation,
                    std::ptr::from_ref(&completion_association).cast::<c_void>(),
                    size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                )
            },
            "SetInformationJobObject completion port",
        )
        .map_err(|error| error.to_string())?;

        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            ..STARTUPINFOW::default()
        };
        let mut process = PROCESS_INFORMATION::default();
        // SAFETY: every pointer references a live, correctly sized buffer for the duration of the call.
        win32_result(
            unsafe {
                CreateProcessW(
                    executable.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    null(),
                    cwd.as_ptr(),
                    &startup,
                    &mut process,
                )
            },
            "CreateProcessW",
        )
        .map_err(|error| error.to_string())?;
        let process_handle = OwnedHandle::new(process.hProcess, "CreateProcessW process handle")
            .map_err(|error| error.to_string())?;
        let thread_handle = OwnedHandle::new(process.hThread, "CreateProcessW thread handle")
            .map_err(|error| error.to_string())?;
        // SAFETY: both handles are live and the process is still suspended, so no descendant can race assignment.
        if let Err(error) = win32_result(
            unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) },
            "AssignProcessToJobObject",
        ) {
            // SAFETY: this helper exclusively owns the still-suspended process handle.
            unsafe {
                TerminateProcess(process_handle.raw(), SUPERVISOR_TERMINATION_EXIT_CODE);
            }
            return Err(error.to_string());
        }

        let job_for_input = job.raw() as usize;
        thread::Builder::new()
            .name("supervisor-control".into())
            .spawn(move || {
                let mut command = [0u8; 1];
                let _ = io::stdin().read(&mut command);
                // SAFETY: main retains the Job Object until the root process exits; this thread only requests termination.
                unsafe {
                    TerminateJobObject(job_for_input as HANDLE, SUPERVISOR_TERMINATION_EXIT_CODE);
                }
            })
            .map_err(|error| format!("could not start the supervisor control thread: {error}"))?;

        // SAFETY: the primary thread handle belongs to the suspended process created above.
        if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
            return Err(format!("ResumeThread: {}", io::Error::last_os_error()));
        }
        let mut stdout = io::stdout().lock();
        writeln!(
            stdout,
            "{{\"type\":\"started\",\"pid\":{}}}",
            process.dwProcessId
        )
        .map_err(|error| format!("could not report process start: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("could not flush process start: {error}"))?;

        // SAFETY: the root process handle remains live until this wait and exit-code read complete.
        let wait = unsafe { WaitForSingleObject(process_handle.raw(), INFINITE) };
        if wait != WAIT_OBJECT_0 {
            return Err(format!("WaitForSingleObject returned {wait}"));
        }
        let mut exit_code = 0u32;
        // SAFETY: the root process is signaled and exit_code is a valid output pointer.
        win32_result(
            unsafe { GetExitCodeProcess(process_handle.raw(), &mut exit_code) },
            "GetExitCodeProcess",
        )
        .map_err(|error| error.to_string())?;
        // End any descendants that outlived the root, then wait for the kernel's definitive empty-job event.
        // SAFETY: the private Job Object remains live and contains only this supervisor's process tree.
        win32_result(
            unsafe { TerminateJobObject(job.raw(), SUPERVISOR_TERMINATION_EXIT_CODE) },
            "TerminateJobObject after root exit",
        )
        .map_err(|error| error.to_string())?;
        loop {
            let mut message = 0u32;
            let mut completion_key = 0usize;
            let mut overlapped = null_mut();
            // SAFETY: output pointers are valid and the completion port remains live for this blocking call.
            win32_result(
                unsafe {
                    GetQueuedCompletionStatus(
                        completion_port.raw(),
                        &mut message,
                        &mut completion_key,
                        &mut overlapped,
                        INFINITE,
                    )
                },
                "GetQueuedCompletionStatus",
            )
            .map_err(|error| error.to_string())?;
            if completion_key == JOB_COMPLETION_KEY && message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
            {
                break;
            }
        }
        writeln!(stdout, "{{\"type\":\"exited\",\"exitCode\":{exit_code}}}")
            .map_err(|error| format!("could not report process exit: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("could not flush process exit: {error}"))?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{command_line, quote_argument};
        use crate::LaunchRequest;
        use std::ffi::{OsStr, OsString};
        use std::path::PathBuf;

        fn decoded(value: Vec<u16>) -> String {
            String::from_utf16(&value).expect("test arguments use valid UTF-16")
        }

        #[test]
        fn quotes_spaces_quotes_and_trailing_backslashes_for_create_process() {
            assert_eq!(
                decoded(quote_argument(OsStr::new("plain")).unwrap()),
                "plain"
            );
            assert_eq!(
                decoded(quote_argument(OsStr::new("two words")).unwrap()),
                "\"two words\""
            );
            assert_eq!(
                decoded(quote_argument(OsStr::new("say \\\"hi\\\"")).unwrap()),
                "\"say \\\\\\\"hi\\\\\\\"\""
            );
            assert_eq!(
                decoded(quote_argument(OsStr::new("C:\\Program Files\\")).unwrap()),
                "\"C:\\Program Files\\\\\""
            );
        }

        #[test]
        fn command_line_includes_argv_zero_and_a_terminal_null() {
            let request = LaunchRequest {
                arguments: vec![OsString::from("argument")],
                cwd: PathBuf::from("C:\\fixture"),
                executable: OsString::from("C:\\Program Files\\fixture.exe"),
            };
            let command = command_line(&request).unwrap();
            assert_eq!(command.last(), Some(&0));
            assert_eq!(
                decoded(command[..command.len() - 1].to_vec()),
                "\"C:\\Program Files\\fixture.exe\" argument"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LaunchRequest, parse_launch_request};
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn parses_one_explicit_working_directory_and_command() {
        assert_eq!(
            parse_launch_request([
                OsString::from("--cwd"),
                OsString::from("C:\\fixture"),
                OsString::from("--"),
                OsString::from("fixture.exe"),
                OsString::from("one"),
            ]),
            Ok(LaunchRequest {
                arguments: vec![OsString::from("one")],
                cwd: PathBuf::from("C:\\fixture"),
                executable: OsString::from("fixture.exe"),
            })
        );
    }

    #[test]
    fn rejects_commands_without_the_separator() {
        assert!(
            parse_launch_request([
                OsString::from("--cwd"),
                OsString::from("C:\\fixture"),
                OsString::from("fixture.exe"),
            ])
            .is_err()
        );
    }
}
