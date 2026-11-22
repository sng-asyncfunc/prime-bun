//! Bun executable discovery and version validation (`>= 1.3.14`).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context};

use super::layout::{expand_home, home_dir};
use crate::kernel::bootstrap::EnsureKernelBunOptions;
use crate::kernel::bun_env::{safe_executable_path, safe_home_bun};

/// Minimum supported Bun version for the persistent JavaScript REPL runtime.
pub const MINIMUM_BUN_VERSION: &str = "1.3.14";

const BUN_INSTALL_COMMAND: &str = "curl -fsSL https://bun.sh/install | bash";

/// Parse a semver-like Bun version string (`major.minor.patch[-pre][+meta]`).
pub(crate) fn parse_bun_version(raw: &str) -> anyhow::Result<(u64, u64, u64)> {
    let trimmed = raw.trim();
    let core = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
    let mut parts = core.split('.');
    let major = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("Invalid Bun version: {trimmed}"))?;
    let minor = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("Invalid Bun version: {trimmed}"))?;
    let patch = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("Invalid Bun version: {trimmed}"))?;
    if parts.next().is_some() {
        return Err(anyhow!("Invalid Bun version: {trimmed}"));
    }
    Ok((major, minor, patch))
}

/// Verify that `version` satisfies [`MINIMUM_BUN_VERSION`].
pub(crate) fn assert_supported_bun_version(version: &str) -> anyhow::Result<()> {
    let actual = parse_bun_version(version)?;
    let minimum = parse_bun_version(MINIMUM_BUN_VERSION)?;
    if actual < minimum {
        return Err(anyhow!(
            "Prime Agent requires Bun {MINIMUM_BUN_VERSION} or newer, found {}",
            version.trim()
        ));
    }
    Ok(())
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["bun.exe", "bun.cmd", "bun.bat", "bun"]
    } else {
        &["bun"]
    }
}

fn home_bun_path() -> PathBuf {
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    home_dir().join(".bun").join("bin").join(name)
}

fn find_safe_bun_on_path(project: Option<&Path>) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() || !dir.is_absolute() {
            continue;
        }
        for name in candidate_names() {
            let candidate = dir.join(name);
            if !is_executable_file(&candidate) {
                continue;
            }
            if safe_executable_path(&candidate, project) || safe_home_bun(&candidate, project) {
                return Some(candidate);
            }
        }
    }
    None
}

pub(crate) fn probe_bun_version(bun_path: &Path) -> anyhow::Result<String> {
    let mut command = std::process::Command::new(bun_path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::process::set_no_window(&mut command);
    let output = command
        .output()
        .with_context(|| format!("failed to run {} --version", bun_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(anyhow!(
            "{} --version failed with exit code {}{}",
            bun_path.display(),
            output.status.code().unwrap_or(-1),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert_supported_bun_version(&version)?;
    Ok(version)
}

fn resolve_bun_candidate(
    project: Option<&Path>,
    prefer_home: bool,
) -> anyhow::Result<(PathBuf, String)> {
    if let Ok(override_bun) = std::env::var("PRIME_AGENT_KERNEL_BUN") {
        let trimmed = override_bun.trim();
        if !trimmed.is_empty() {
            let path = expand_home(trimmed);
            let version = probe_bun_version(&path).map_err(|error| {
                anyhow!(
                    "PRIME_AGENT_KERNEL_BUN points to an unusable Bun executable ({}): {error:#}. \
                     Install Bun {MINIMUM_BUN_VERSION} or newer, or unset PRIME_AGENT_KERNEL_BUN.",
                    path.display()
                )
            })?;
            return Ok((path, version));
        }
    }

    let home_candidate = home_bun_path();
    let candidate = if prefer_home {
        home_candidate
    } else if let Some(path_bun) = find_safe_bun_on_path(project) {
        path_bun
    } else if is_executable_file(&home_candidate)
        && (safe_executable_path(&home_candidate, project)
            || safe_home_bun(&home_candidate, project))
    {
        home_candidate
    } else {
        return Err(anyhow!(
            "Bun {MINIMUM_BUN_VERSION}+ was not found on PATH or at {}.",
            home_candidate.display()
        ));
    };

    let version = probe_bun_version(&candidate).map_err(|error| {
        anyhow!(
            "Unable to use Bun at {}. Install Bun {MINIMUM_BUN_VERSION} or newer, or set \
             PRIME_AGENT_KERNEL_BUN to a supported executable. ({error:#})",
            candidate.display()
        )
    })?;
    Ok((candidate, version))
}

#[cfg(unix)]
async fn install_bun_unix(options: &EnsureKernelBunOptions) -> anyhow::Result<()> {
    options.report("› installing Bun (one-time)…");
    let status = tokio::task::spawn_blocking(|| {
        std::process::Command::new("sh")
            .args(["-c", BUN_INSTALL_COMMAND])
            .stdin(Stdio::null())
            .status()
            .context("failed to run Bun installer")
    })
    .await
    .map_err(|e| anyhow!("Bun installer task join failed: {e}"))??;
    if !status.success() {
        return Err(anyhow!(
            "Bun installer exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Resolve a supported Bun executable (`>= 1.3.14`), honoring
/// `PRIME_AGENT_KERNEL_BUN`, safe `PATH`, `~/.bun/bin/bun`, and (on Unix when
/// `PRIME_AGENT_INSTALL_BUN=1` and no explicit override is set) installing Bun.
pub(crate) async fn resolve_or_install_bun(
    options: &EnsureKernelBunOptions,
    project: Option<&Path>,
) -> anyhow::Result<(PathBuf, String)> {
    match resolve_bun_candidate(project, false) {
        Ok(found) => Ok(found),
        Err(initial_error) => {
            let has_override =
                std::env::var("PRIME_AGENT_KERNEL_BUN").is_ok_and(|v| !v.trim().is_empty());
            let allow_install =
                !has_override && std::env::var("PRIME_AGENT_INSTALL_BUN").as_deref() == Ok("1");
            #[cfg(unix)]
            if allow_install {
                install_bun_unix(options).await.map_err(|install_error| {
                    anyhow!(
                        "couldn't install Bun from bun.sh; run `{BUN_INSTALL_COMMAND}`, then retry. {install_error:#}"
                    )
                })?;
                return resolve_bun_candidate(project, true);
            }
            #[cfg(not(unix))]
            let _ = allow_install;
            Err(anyhow!(
                "Bun {MINIMUM_BUN_VERSION}+ is required for the persistent JavaScript runtime. \
                 Install it with `{BUN_INSTALL_COMMAND}`, or set PRIME_AGENT_INSTALL_BUN=1 to let \
                 Prime Agent run that installer. {initial_error:#}"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bun_version_parsing_and_minimum_check() {
        assert_eq!(parse_bun_version("1.3.14").unwrap(), (1, 3, 14));
        assert_eq!(parse_bun_version("1.3.14-canary.1\n").unwrap(), (1, 3, 14));
        assert_eq!(parse_bun_version("2.0.0+abc").unwrap(), (2, 0, 0));
        assert!(parse_bun_version("not-a-version").is_err());
        assert!(parse_bun_version("1.3").is_err());

        assert!(assert_supported_bun_version("1.3.14").is_ok());
        assert!(assert_supported_bun_version("1.3.15").is_ok());
        assert!(assert_supported_bun_version("1.4.0").is_ok());
        assert!(assert_supported_bun_version("2.0.0").is_ok());
        assert!(assert_supported_bun_version("1.3.13").is_err());
        assert!(assert_supported_bun_version("1.2.99").is_err());
        assert!(assert_supported_bun_version("0.9.0").is_err());
    }
}
