//! `.bootstrap-version` persistence and validation for `kernel-bun`.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;

pub(crate) const BOOTSTRAP_SCHEMA: u64 = 1;
pub(crate) const BOOTSTRAP_VERSION_FILE: &str = ".bootstrap-version";

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapVersion {
    pub(crate) schema: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dependencies: Option<BTreeMap<String, String>>,
}

pub(crate) fn read_bootstrap_version_raw(kernel_dir: &Path) -> (Option<BootstrapVersion>, String) {
    let path = kernel_dir.join(BOOTSTRAP_VERSION_FILE);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return (None, String::new());
    };
    let parsed = serde_json::from_str::<BootstrapVersion>(&raw).ok();
    (parsed, raw)
}

pub(crate) fn write_bootstrap_version(
    kernel_dir: &Path,
    runtime_identity: &str,
    dependencies: &BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let record = BootstrapVersion {
        schema: BOOTSTRAP_SCHEMA,
        runtime: Some(runtime_identity.to_string()),
        dependencies: Some(dependencies.clone()),
    };
    let body = format!("{}\n", serde_json::to_string(&record)?);
    write_atomic(&kernel_dir.join(BOOTSTRAP_VERSION_FILE), &body)
}

pub(crate) fn write_atomic(path: &Path, content: &str) -> anyhow::Result<()> {
    let tmp = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp, content).with_context(|| format!("writing {}", tmp.display()))?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error)
            .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()));
    }
    Ok(())
}

/// True when `.bootstrap-version` matches the expected schema, runtime hash,
/// and runtime dependencies, AND the staged worker entry plus required runtime
/// packages (`acorn`, `@modelcontextprotocol/sdk`) exist on disk.
pub(crate) fn bootstrap_version_current(
    version: Option<&BootstrapVersion>,
    runtime_identity: &str,
    expected_deps: &BTreeMap<String, String>,
    kernel_dir: &Path,
) -> bool {
    let Some(version) = version else {
        return false;
    };
    if version.schema != BOOTSTRAP_SCHEMA {
        return false;
    }
    if version.runtime.as_deref() != Some(runtime_identity) {
        return false;
    }
    if version.dependencies.as_ref() != Some(expected_deps) {
        return false;
    }
    kernel_dir.join("src").join("repl.ts").is_file()
        && kernel_dir
            .join("node_modules")
            .join("acorn")
            .join("package.json")
            .is_file()
        && kernel_dir
            .join("node_modules")
            .join("@modelcontextprotocol")
            .join("sdk")
            .join("package.json")
            .is_file()
}
