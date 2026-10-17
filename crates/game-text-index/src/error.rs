//! Stable native index failure categories. Classification never depends on diagnostic prose.
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Busy,
    InvalidInput,
    InvalidCache,
    LimitExceeded,
    StaleGeneration,
    Unavailable,
    NotFound,
    Io,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::InvalidInput => "invalid_input",
            Self::InvalidCache => "invalid_cache",
            Self::LimitExceeded => "limit_exceeded",
            Self::StaleGeneration => "stale_generation",
            Self::Unavailable => "unavailable",
            Self::NotFound => "not_found",
            Self::Io => "io_error",
        }
    }
}

#[derive(Debug)]
pub struct Error {
    pub code: ErrorCode,
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }

    pub fn with_source(
        code: ErrorCode,
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if let Some(source) = &self.source {
            write!(f, ": {source}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source.as_ref() as &dyn std::error::Error)
    }
}

// Unprefixed assertions describe invalid disposable cache structures. Request validation uses
// explicit ErrorCode::InvalidInput; callers cannot accidentally change a code by editing prose.
impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Self::new(ErrorCode::InvalidCache, message)
    }
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::new(ErrorCode::InvalidCache, message)
    }
}
impl From<std::io::Error> for Error {
    fn from(source: std::io::Error) -> Self {
        let code = if source.kind() == std::io::ErrorKind::NotFound {
            ErrorCode::NotFound
        } else {
            ErrorCode::Io
        };
        Self::with_source(
            code,
            "A native Game Text cache file operation failed.",
            source,
        )
    }
}

macro_rules! cache_source {
    ($($kind:ty),+ $(,)?) => {$(
        impl From<$kind> for Error {
            fn from(source: $kind) -> Self {
                Self::with_source(ErrorCode::InvalidCache, "A native Game Text cache value is invalid.", source)
            }
        }
    )+};
}
cache_source!(
    serde_json::Error,
    std::str::Utf8Error,
    std::string::FromUtf8Error,
    std::array::TryFromSliceError,
    std::num::ParseIntError,
    std::num::TryFromIntError
);

impl From<regex::Error> for Error {
    fn from(source: regex::Error) -> Self {
        Self::with_source(
            ErrorCode::InvalidInput,
            "The join policy contains an invalid regular expression.",
            source,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_does_not_depend_on_message_and_sources_are_retained() {
        let typed = Error::new(ErrorCode::Busy, "another writer currently owns this view");
        assert_eq!(typed.code.as_str(), "busy");
        let cache: Error = "busy is ordinary text inside a corrupt cache".into();
        assert_eq!(cache.code, ErrorCode::InvalidCache);
        let io = Error::from(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(io.code, ErrorCode::NotFound);
        assert!(
            io.to_string()
                .contains(&std::io::Error::from(std::io::ErrorKind::NotFound).to_string())
        );
        assert!(
            std::error::Error::source(&io)
                .unwrap()
                .is::<std::io::Error>()
        );
    }
}
