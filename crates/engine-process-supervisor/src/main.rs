use engine_process_supervisor::{VERSION, parse_launch_request};

fn main() {
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
