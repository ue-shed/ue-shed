use engine_process_supervisor::{VERSION, parse_launch_request};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--allow-foreground") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        let pid = args
            .first()
            .filter(|_| args.len() == 1)
            .and_then(|value| engine_process_supervisor::parse_foreground_pid(value).ok());
        let Some(pid) = pid else {
            eprintln!("usage: ue-shed-process-supervisor --allow-foreground <process-id>");
            std::process::exit(2);
        };
        #[cfg(windows)]
        {
            // The foreground client starts this helper, which transfers its inherited foreground
            // permission to the connected editor. Windows remains the authority on granting it.
            let granted = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid)
            } != 0;
            println!("{}", if granted { "granted" } else { "denied" });
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            println!("unsupported");
        }
        return;
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--version")) {
        println!("ue-shed-process-supervisor {VERSION}");
        return;
    }
    let request = match parse_launch_request(std::env::args_os().skip(1)) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    #[cfg(windows)]
    if let Err(error) = engine_process_supervisor::windows::run(request) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        eprintln!("the native process supervisor supports Windows only");
        std::process::exit(1);
    }
}
