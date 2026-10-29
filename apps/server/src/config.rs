//! Operator-only startup configuration. Browser commands cannot select paths,
//! executables, extension files, bind addresses or arbitrary Pi arguments.
use std::{
    fs::File,
    io::{self, Read},
    path::PathBuf,
};

pub const HELP: &str = "pi-web [--cwd PATH] [--new | --session FILE] [--port PORT]\n\
  [--state-dir PATH] [--session-root PATH] [--pi EXECUTABLE]\n\
  [--web-dir PATH] [--head-adapter PATH] [--quota-adapter PATH] [--isolated]\n\
  [--remote-origin https://HOSTNAME] [--revoke-push]\n\n\
Binds only 127.0.0.1. Open the printed URL to authenticate this browser.\n\
--remote-origin selects one private HTTPS proxy origin (default port 443; no trailing slash).\n\
Defaults to the remembered exact session for the canonical project.\n\
--new creates a new session without deleting prior Pi files.\n\
--revoke-push clears persistent phone subscriptions and exits; stop the server first.\n\
--isolated disables optional extensions, MCP, context discovery and all tools but read.\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Startup {
    Remembered,
    New,
    Session(PathBuf),
}

/// Canonical HTTPS DNS origin for an operator-managed private reverse proxy on port 443.
/// Validation excludes URL components and characters that could broaden browser policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteOrigin(String);
impl RemoteOrigin {
    /// Accepts `https://` followed by a lowercase DNS hostname, without port or trailing slash.
    /// Returns InvalidInput for other schemes, URL components, malformed DNS labels,
    /// or numeric final labels that browsers interpret as IPv4 addresses.
    pub fn parse(value: String) -> io::Result<Self> {
        let host = value.strip_prefix("https://").unwrap_or("");
        if host.len() > 253
            || !host.contains('.')
            // Browsers also interpret abbreviated, octal and hexadecimal IPv4 forms.
            || host.rsplit('.').next().is_some_and(|label| {
                label.bytes().all(|b| b.is_ascii_digit())
                    || label
                        .strip_prefix("0x")
                        .is_some_and(|digits| digits.bytes().all(|b| b.is_ascii_hexdigit()))
            })
            || !host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        {
            return Err(invalid(
                "remote origin must be https:// followed by a lowercase DNS hostname (port 443, no port, path, trailing slash, query or fragment)",
            ));
        }
        Ok(Self(value))
    }

    /// Returns the exact browser origin, including its HTTPS scheme.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the validated DNS authority used by the proxy's preserved Host header.
    pub fn authority(&self) -> &str {
        &self.0[8..]
    }
}

/// Validated startup options. Only the project directory may later be selected by a browser.
#[derive(Debug, Clone)]
pub struct Config {
    pub cwd: PathBuf,
    pub explicit_cwd: bool,
    pub custom_state: bool,
    pub registry_dir: PathBuf,
    pub state_dir: PathBuf,
    pub session_roots: Vec<PathBuf>,
    pub startup: Startup,
    pub port: u16,
    pub remote_origin: Option<RemoteOrigin>,
    pub pi: PathBuf,
    pub web_dir: PathBuf,
    pub head_adapter: PathBuf,
    pub quota_adapter: PathBuf,
    pub isolated: bool,
    pub revoke_push: bool,
}
impl Config {
    /// Parses without creating files or starting Pi. `None` requests help.
    pub fn parse(args: impl IntoIterator<Item = String>) -> io::Result<Option<Self>> {
        let mut args = args.into_iter();
        let mut cwd = std::env::current_dir()?;
        let mut explicit_cwd = false;
        let mut state_dir = None;
        let mut session_roots = Vec::new();
        let mut startup = Startup::Remembered;
        let mut port = 9876;
        let mut remote_origin = None;
        let mut pi = PathBuf::from("pi-bolt");
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut web_dir = manifest.join("../web/dist");
        let mut head_adapter = manifest.join("pi/history-head.ts");
        let mut quota_adapter = manifest.join("pi/codex-usage.ts");
        let mut isolated = false;
        let mut revoke_push = false;
        while let Some(flag) = args.next() {
            if flag == "--help" || flag == "-h" {
                return Ok(None);
            }
            if flag == "--new" {
                if startup != Startup::Remembered {
                    return Err(invalid("--new and --session are mutually exclusive"));
                }
                startup = Startup::New;
                continue;
            }
            if flag == "--revoke-push" {
                revoke_push = true;
                continue;
            }
            if flag == "--isolated" {
                isolated = true;
                continue;
            }
            if !matches!(
                flag.as_str(),
                "--cwd"
                    | "--state-dir"
                    | "--session-root"
                    | "--session"
                    | "--port"
                    | "--remote-origin"
                    | "--pi"
                    | "--web-dir"
                    | "--head-adapter"
                    | "--quota-adapter"
            ) {
                return Err(invalid(format!("unknown option: {flag}")));
            }
            let value = args
                .next()
                .filter(|value| !value.is_empty() && !value.starts_with("--"))
                .ok_or_else(|| invalid(format!("missing value for {flag}")))?;
            match flag.as_str() {
                "--cwd" => {
                    cwd = value.into();
                    explicit_cwd = true;
                }
                "--state-dir" => state_dir = Some(PathBuf::from(value)),
                "--session-root" => session_roots.push(PathBuf::from(value)),
                "--session" => {
                    if startup != Startup::Remembered {
                        return Err(invalid("--new and --session are mutually exclusive"));
                    }
                    startup = Startup::Session(value.into());
                }
                "--port" => {
                    port = value
                        .parse::<u16>()
                        .map_err(|_| invalid("port must be 0..65535"))?
                }
                "--remote-origin" => {
                    if remote_origin.is_some() {
                        return Err(invalid("--remote-origin may only be specified once"));
                    }
                    remote_origin = Some(RemoteOrigin::parse(value)?);
                }
                "--pi" => pi = value.into(),
                "--web-dir" => web_dir = value.into(),
                "--head-adapter" => head_adapter = value.into(),
                "--quota-adapter" => quota_adapter = value.into(),
                _ => unreachable!(),
            }
        }
        let cwd = cwd.canonicalize()?;
        if !cwd.is_dir() {
            return Err(invalid("project must be a directory"));
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| invalid("HOME is required"))?;
        let custom_state = state_dir.is_some();
        let state_dir = state_dir.unwrap_or_else(|| {
            home.join("Library/Application Support/pi-web")
                .join(project_key(&cwd))
        });
        let state_dir = if state_dir.is_absolute() {
            state_dir
        } else {
            std::env::current_dir()?.join(state_dir)
        };
        let registry_dir = if custom_state {
            state_dir.join("workspaces")
        } else {
            home.join("Library/Application Support/pi-web/workspaces")
        };
        session_roots.push(state_dir.join("pi-sessions"));
        session_roots.push(home.join(".pi/agent/sessions"));
        Ok(Some(Self {
            cwd,
            explicit_cwd,
            custom_state,
            registry_dir,
            state_dir,
            session_roots,
            startup,
            port,
            remote_origin,
            pi,
            web_dir,
            head_adapter,
            quota_adapter,
            isolated,
            revoke_push,
        }))
    }
    /// Derives runtime options for a registered folder, retaining operator-only options.
    pub(crate) fn for_project(&self, cwd: PathBuf, state_dir: PathBuf) -> Self {
        let mut config = self.clone();
        config
            .session_roots
            .retain(|root| *root != self.state_dir.join("pi-sessions"));
        config.session_roots.push(state_dir.join("pi-sessions"));
        config.session_roots.push(state_dir.join("sessions"));
        config.cwd = cwd;
        config.state_dir = state_dir;
        config.startup = Startup::Remembered;
        config
    }
    pub(crate) fn additional_state_dir(&self, cwd: &std::path::Path) -> PathBuf {
        if self.custom_state {
            self.registry_dir
                .parent()
                .expect("registry has parent")
                .join("projects")
                .join(project_key(cwd))
        } else {
            self.registry_dir
                .parent()
                .expect("registry has parent")
                .join(project_key(cwd))
        }
    }
}

/// Stable directory lookup key, not a security identifier. Persisted metadata also
/// verifies the complete canonical project path, so a collision cannot resume another project.
pub(crate) fn project_key(path: &std::path::Path) -> String {
    let hash = path
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
}

/// Generates a cryptographically random capability from the operating system.
pub fn capability() -> io::Result<String> {
    Ok(random_bytes::<32>()?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Generates independent RFC4122 version-4 identities for app sessions and epochs.
pub fn identity() -> io::Result<String> {
    let mut bytes = random_bytes::<16>()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn invalid(message: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_string())
}
