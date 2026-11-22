//! Bun kernel runtime provisioning: sync `prime-agent-runtime/` into
//! `kernel-bun`, install production dependencies, and prepare JavaScript skills.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;

use anyhow::{anyhow, Context};

use super::EnsureKernelBunOptions;

pub(crate) mod bun_bin;
pub(crate) mod layout;
pub(crate) mod probe;
pub(crate) mod runtime_source;
pub(crate) mod skills;
pub(crate) mod version;

pub(crate) use bun_bin::resolve_or_install_bun;
pub use bun_bin::MINIMUM_BUN_VERSION;
pub(crate) use layout::resolve_writable_kernel_bun_dir;
pub use layout::{kernel_bun_dir, kernel_worker_entry};
pub use probe::invalidate_runtime_probe_cache;
pub(crate) use probe::kernel_runtime_ready;
pub(crate) use runtime_source::{
    hash_runtime_source, package_dir, packaged_runtime_dir, read_runtime_dependencies,
    require_runtime_source_dir,
};
pub(crate) use skills::prepare_javascript_skills;
use version::{write_atomic, write_bootstrap_version};

pub(crate) const BOOTSTRAP_LOCK_NAME: &str = ".bootstrap.lock";
pub(crate) const BOOTSTRAP_LOCK_RETRY_MS: u64 = 100;
pub(crate) const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS: u64 = 30_000;

pub(crate) async fn run_bun_install(
    bun_path: &Path,
    working_dir: &Path,
    project: Option<&Path>,
) -> anyhow::Result<()> {
    let bun_path = bun_path.to_path_buf();
    let working_dir = working_dir.to_path_buf();
    let project = project.map(Path::to_path_buf);
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&bun_path);
        command
            .args(["install", "--production"])
            .current_dir(&working_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut env = crate::kernel::bun_env::inherited_bun_env();
        crate::kernel::bun_env::sanitize_bun_path(&mut env, project.as_deref());
        command.env_clear().envs(env);
        crate::platform::process::set_no_window(&mut command);
        let output = command
            .output()
            .with_context(|| format!("failed to spawn {}", bun_path.display()))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            Err(anyhow!(
                "{} install --production failed with exit code {}{}",
                bun_path.display(),
                output.status.code().unwrap_or(-1),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            ))
        }
    })
    .await
    .map_err(|e| anyhow!("bun install task join failed: {e}"))?
}

fn read_existing_kernel_dependencies(kernel_dir: &Path) -> BTreeMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(kernel_dir.join("package.json")) else {
        return BTreeMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return BTreeMap::new();
    };
    let Some(obj) = parsed
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
    else {
        return BTreeMap::new();
    };
    obj.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}

fn copy_runtime_tree(src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if matches!(name_str.as_ref(), "node_modules" | ".git" | "test") {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        let meta = std::fs::metadata(&src_path)?;
        if meta.is_dir() {
            copy_runtime_tree(&src_path, &dst_path)?;
        } else if meta.is_file() {
            std::fs::copy(&src_path, &dst_path).with_context(|| {
                format!("copying {} -> {}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}

/// Sync `prime-agent-runtime/src` into `kernel_dir/src`, merge `package.json`
/// dependencies (preserving any user-installed packages from `installPackage`),
/// run `bun install --production`, and write `.bootstrap-version`.
pub(crate) async fn provision_kernel_runtime(
    bun_path: &Path,
    kernel_dir: &Path,
    source_dir: &Path,
    runtime_identity: &str,
    expected_deps: &BTreeMap<String, String>,
    options: &EnsureKernelBunOptions,
    project: Option<&Path>,
) -> anyhow::Result<()> {
    options.report("› preparing Bun runtime (one-time)…");
    std::fs::create_dir_all(kernel_dir)
        .with_context(|| format!("creating {}", kernel_dir.display()))?;

    let dst_src = kernel_dir.join("src");
    if dst_src.exists() {
        std::fs::remove_dir_all(&dst_src)
            .with_context(|| format!("clearing {}", dst_src.display()))?;
    }
    copy_runtime_tree(&source_dir.join("src"), &dst_src)?;

    let mut merged_deps = read_existing_kernel_dependencies(kernel_dir);
    for (name, version) in expected_deps {
        merged_deps.insert(name.clone(), version.clone());
    }
    let package_json = serde_json::to_string_pretty(&serde_json::json!({
        "name": "prime-agent-runtime",
        "private": true,
        "type": "module",
        "dependencies": merged_deps,
    }))?;
    write_atomic(
        &kernel_dir.join("package.json"),
        &format!("{package_json}\n"),
    )?;

    run_bun_install(bun_path, kernel_dir, project).await?;
    write_bootstrap_version(kernel_dir, runtime_identity, expected_deps)?;
    options.report("✓ Bun runtime ready");
    Ok(())
}
