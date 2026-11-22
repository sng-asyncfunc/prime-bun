//! Kernel Bun runtime bootstrap: the public entry point [`ensure_kernel_bun`]
//! resolves Bun (`>= 1.3.14`), provisions the `kernel-bun` runtime directory
//! from `prime-agent-runtime/`, prepares JavaScript skill dependency caches,
//! and deduplicates concurrent bootstraps.

pub(crate) mod bun;
pub(crate) mod dir_lock;
mod disk_memo;
mod runtime_code;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;

use bun::{
    hash_runtime_source, kernel_runtime_ready, package_dir, packaged_runtime_dir,
    prepare_javascript_skills, provision_kernel_runtime, read_runtime_dependencies,
    require_runtime_source_dir, resolve_or_install_bun, resolve_writable_kernel_bun_dir,
};
pub use bun::{
    invalidate_runtime_probe_cache, kernel_bun_dir, kernel_worker_entry, MINIMUM_BUN_VERSION,
};
use dir_lock::acquire_bootstrap_lock;
pub use runtime_code::{
    build_rlm_bootstrap_code, parse_unavailable_javascript_skills, UnavailableJavaScriptSkills,
    JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER,
};

/// One JavaScript skill the kernel should load at bootstrap.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelJavaScriptSkill {
    pub name: String,
    pub global_name: String,
    pub entry_path: PathBuf,
    pub package_path: PathBuf,
    pub package_json_path: PathBuf,
}

/// One JavaScript skill after dependency preparation; a failed skill carries
/// `unavailable_reason` so the worker binds an unavailable placeholder without
/// failing kernel startup.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedJavaScriptSkill {
    pub name: String,
    pub global_name: String,
    pub entry_path: PathBuf,
    pub package_path: PathBuf,
    pub package_json_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

impl PreparedJavaScriptSkill {
    #[must_use]
    pub fn from_skill(skill: KernelJavaScriptSkill, unavailable_reason: Option<String>) -> Self {
        Self {
            name: skill.name,
            global_name: skill.global_name,
            entry_path: skill.entry_path,
            package_path: skill.package_path,
            package_json_path: skill.package_json_path,
            unavailable_reason,
        }
    }
}

/// Resolved Bun kernel runtime returned by [`ensure_kernel_bun`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelBunRuntime {
    pub bun_path: PathBuf,
    pub bun_version: String,
    pub kernel_dir: PathBuf,
    pub worker_entry: PathBuf,
    pub prepared_skills: Vec<PreparedJavaScriptSkill>,
}

/// Progress callback for [`ensure_kernel_bun`].
pub type KernelBootstrapProgressHandler = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct EnsureKernelBunOptions {
    pub javascript_skills: Vec<KernelJavaScriptSkill>,
    pub on_progress: Option<KernelBootstrapProgressHandler>,
    /// Optional override for the `prime-agent-runtime` source directory.
    pub runtime_source_dir: Option<PathBuf>,
}

impl EnsureKernelBunOptions {
    pub(crate) fn report(&self, message: &str) {
        match &self.on_progress {
            Some(handler) => handler(message),
            None => eprintln!("{message}"),
        }
    }
}

fn format_bootstrap_failure(error: &anyhow::Error) -> anyhow::Error {
    let mut message = format!(
        "Failed to set up the Bun JavaScript kernel runtime. {error:#}\n\
         First-time setup needs Bun >= {MINIMUM_BUN_VERSION}, the bundled local runtime, and internet to install its JavaScript packages; once set up, Prime Agent runs offline. \
         Set PRIME_AGENT_KERNEL_BUN to a supported Bun executable or PRIME_AGENT_KERNEL_BUN_DIR to a writable runtime directory."
    );
    if packaged_runtime_dir().is_none() {
        let package = package_dir();
        let _ = write!(
            message,
            "\nThe packaged prime-agent-runtime directory was not found (looked next to the executable at {} and PI_PACKAGE_DIR); reinstall prime-agent so the kernel runtime ships beside the binary.",
            package.display()
        );
    }
    anyhow!(message)
}

type InFlightBootstrap = Option<(
    String,
    Arc<tokio::sync::Mutex<Option<anyhow::Result<KernelBunRuntime>>>>,
)>;

static IN_FLIGHT: Mutex<InFlightBootstrap> = Mutex::new(None);

/// Resolve Bun (`>= 1.3.14`), provision `kernel-bun` from `prime-agent-runtime/`,
/// and prepare all JavaScript skills.
///
/// # Errors
///
/// Returns an error when Bun is unavailable or too old, the runtime source
/// payload is missing, or `bun install --production` fails.
///
/// # Panics
///
/// The in-flight promise stores its outcome under the same lock, so the `expect`
/// is unreachable.
pub async fn ensure_kernel_bun(
    options: EnsureKernelBunOptions,
) -> anyhow::Result<KernelBunRuntime> {
    ensure_kernel_bun_for_project(options, std::env::current_dir().ok()).await
}

/// Same as [`ensure_kernel_bun`] scoped to the given project directory for safe
/// `PATH` boundary checks.
///
/// # Errors
///
/// Returns an error when Bun is unavailable or too old, the runtime source
/// payload is missing, or `bun install --production` fails.
///
/// # Panics
///
/// The in-flight promise stores its outcome under the same lock, so the `expect`
/// is unreachable.
pub async fn ensure_kernel_bun_for_project(
    options: EnsureKernelBunOptions,
    project: Option<PathBuf>,
) -> anyhow::Result<KernelBunRuntime> {
    let key = [
        project
            .as_ref()
            .map_or_else(String::new, |path| path.to_string_lossy().into_owned()),
        std::env::var("PRIME_AGENT_KERNEL_BUN").unwrap_or_default(),
        std::env::var("PRIME_AGENT_KERNEL_BUN_DIR").unwrap_or_default(),
        std::env::var("HOME").unwrap_or_default(),
        std::env::var("XDG_DATA_HOME").unwrap_or_default(),
        options
            .runtime_source_dir
            .as_ref()
            .map_or_else(String::new, |path| path.to_string_lossy().into_owned()),
        serde_json::to_string(&options.javascript_skills).unwrap_or_default(),
    ]
    .join("\u{0}");

    let shared = {
        let mut in_flight = IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match in_flight.as_ref() {
            Some((existing_key, promise)) if *existing_key == key => promise.clone(),
            _ => {
                let promise = Arc::new(tokio::sync::Mutex::new(None));
                *in_flight = Some((key, promise.clone()));
                promise
            }
        }
    };
    let mut guard = shared.lock().await;
    if guard.is_none() {
        *guard = Some(ensure_kernel_bun_uncached(&options, project.as_deref()).await);
    }
    let outcome = guard.take().expect("outcome was just stored");
    let mut in_flight = IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if matches!(in_flight.as_ref(), Some((_, promise)) if Arc::ptr_eq(promise, &shared)) {
        *in_flight = None;
    }
    outcome
}

async fn ensure_kernel_bun_uncached(
    options: &EnsureKernelBunOptions,
    project: Option<&Path>,
) -> anyhow::Result<KernelBunRuntime> {
    let has_override =
        std::env::var("PRIME_AGENT_KERNEL_BUN").is_ok_and(|value| !value.trim().is_empty());
    if !has_override {
        require_runtime_source_dir(options.runtime_source_dir.as_deref())
            .map_err(|error| format_bootstrap_failure(&error))?;
    }
    let (bun_path, bun_version) =
        resolve_or_install_bun(options, project)
            .await
            .map_err(|error| {
                if has_override {
                    error
                } else {
                    format_bootstrap_failure(&error)
                }
            })?;
    let kernel_dir = resolve_writable_kernel_bun_dir()?;
    ensure_kernel_bun_in_dir(options, &bun_path, &bun_version, kernel_dir, project).await
}

async fn ensure_kernel_bun_in_dir(
    options: &EnsureKernelBunOptions,
    bun_path: &Path,
    bun_version: &str,
    kernel_dir: PathBuf,
    project: Option<&Path>,
) -> anyhow::Result<KernelBunRuntime> {
    let source_dir = require_runtime_source_dir(options.runtime_source_dir.as_deref())
        .map_err(|error| format_bootstrap_failure(&error))?;
    let runtime_identity =
        hash_runtime_source(&source_dir).map_err(|error| format_bootstrap_failure(&error))?;
    let expected_deps =
        read_runtime_dependencies(&source_dir).map_err(|error| format_bootstrap_failure(&error))?;

    if !kernel_runtime_ready(
        bun_path,
        bun_version,
        &kernel_dir,
        &runtime_identity,
        &expected_deps,
    ) {
        let release_lock = match acquire_bootstrap_lock(&kernel_dir).await {
            Ok(lock) => Some(lock),
            Err(error) if dir_lock::lock_creation_denied(&error) => {
                if !kernel_runtime_ready(
                    bun_path,
                    bun_version,
                    &kernel_dir,
                    &runtime_identity,
                    &expected_deps,
                ) {
                    return Err(anyhow!(
                        "cannot set up the Bun JavaScript kernel runtime: {} is not writable by this user and does not hold a current runtime. Set PRIME_AGENT_KERNEL_BUN_DIR to a writable directory. ({error:#})",
                        kernel_dir.display()
                    ));
                }
                None
            }
            Err(error) => return Err(error),
        };
        if let Some(lock) = release_lock {
            let result = async {
                if kernel_runtime_ready(
                    bun_path,
                    bun_version,
                    &kernel_dir,
                    &runtime_identity,
                    &expected_deps,
                ) {
                    return Ok(());
                }
                provision_kernel_runtime(
                    bun_path,
                    &kernel_dir,
                    &source_dir,
                    &runtime_identity,
                    &expected_deps,
                    options,
                    project,
                )
                .await
            }
            .await;
            drop(lock);
            result.map_err(|error| format_bootstrap_failure(&error))?;
        }
    }

    let prepared_skills = prepare_javascript_skills(
        bun_path,
        &kernel_dir,
        &options.javascript_skills,
        options,
        project,
    )
    .await;
    Ok(KernelBunRuntime {
        bun_path: bun_path.to_path_buf(),
        bun_version: bun_version.to_string(),
        worker_entry: kernel_worker_entry(&kernel_dir),
        kernel_dir,
        prepared_skills,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn lock_timeout_prevents_kernel_dir_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("prime-agent-runtime");
        std::fs::create_dir_all(source.join("src")).unwrap();
        std::fs::write(
            source.join("package.json"),
            r#"{"name":"prime-agent-runtime","type":"module","dependencies":{"acorn":"^8.18.0"}}"#,
        )
        .unwrap();
        std::fs::write(source.join("src/repl.ts"), "console.log('ready');\n").unwrap();

        let kernel_dir = root.path().join("kernel-bun");
        std::fs::create_dir(&kernel_dir).unwrap();
        let sentinel = kernel_dir.join("owner-state");
        std::fs::write(&sentinel, "another bootstrap owns this dir").unwrap();
        let owner = acquire_bootstrap_lock(&kernel_dir).await.unwrap();
        let options = EnsureKernelBunOptions {
            runtime_source_dir: Some(source),
            on_progress: Some(Arc::new(|message| {
                panic!("bootstrap must stop at the lock error, got progress: {message}");
            })),
            ..Default::default()
        };

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(121),
            ensure_kernel_bun_in_dir(
                &options,
                Path::new("/usr/local/bin/bun"),
                "1.3.14",
                kernel_dir,
                None,
            ),
        )
        .await
        .expect("lock acquisition must have a bounded wait")
        .expect_err("a lock timeout must propagate to the caller");

        assert!(error.to_string().contains("Timed out"), "{error}");
        assert_eq!(
            std::fs::read_to_string(sentinel).unwrap(),
            "another bootstrap owns this dir"
        );
        assert!(root.path().join("kernel-bun.bootstrap.lock").exists());
        drop(owner);
    }
}
