//! The Bun kernel directory layout: override-aware `kernel-bun` directory,
//! writable-dir fallback, and worker entrypoint path.

use std::path::{Path, PathBuf};

use anyhow::anyhow;

pub(crate) fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

pub(super) fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Directory of the Bun kernel runtime, honoring `PRIME_AGENT_KERNEL_BUN_DIR`.
#[must_use]
pub fn kernel_bun_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PRIME_AGENT_KERNEL_BUN_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return expand_home(trimmed);
        }
    }
    home_dir().join(".prime").join("agent").join("kernel-bun")
}

fn xdg_kernel_bun_dir() -> PathBuf {
    let data_home = match std::env::var("XDG_DATA_HOME") {
        Ok(value) if !value.trim().is_empty() => expand_home(value.trim()),
        _ => home_dir().join(".local").join("share"),
    };
    data_home.join("prime").join("agent").join("kernel-bun")
}

pub(crate) fn resolve_writable_kernel_bun_dir() -> anyhow::Result<PathBuf> {
    let primary = kernel_bun_dir();
    if std::fs::create_dir_all(primary.parent().unwrap_or(Path::new("/"))).is_ok() {
        return Ok(primary);
    }
    if std::env::var("PRIME_AGENT_KERNEL_BUN_DIR").is_ok_and(|v| !v.trim().is_empty()) {
        return Err(anyhow!(
            "couldn't create Bun kernel parent directories for {}",
            primary.display()
        ));
    }
    let fallback = xdg_kernel_bun_dir();
    if std::fs::create_dir_all(fallback.parent().unwrap_or(Path::new("/"))).is_err() {
        return Err(anyhow!(
            "couldn't create Bun kernel directory at {} or {}; set PRIME_AGENT_KERNEL_BUN_DIR to a writable directory",
            primary.display(),
            fallback.display()
        ));
    }
    Ok(fallback)
}

/// Path of the staged Bun REPL worker entrypoint inside `kernel_dir`.
#[must_use]
pub fn kernel_worker_entry(kernel_dir: &Path) -> PathBuf {
    kernel_dir.join("src").join("repl.ts")
}
