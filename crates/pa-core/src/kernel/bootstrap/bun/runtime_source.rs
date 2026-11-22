//! The runtime source concern: the packaged `prime-agent-runtime/` sidecar
//! layout, source-checkout fallback, and content identity that invalidates an
//! existing `kernel-bun` directory on any runtime change.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use sha2::Digest;

use super::layout::expand_home;

/// Directory of the installed `prime-agent-runtime` sources.
pub(crate) fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_home(&env_dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| crate::packages::exe_dir_of(&exe))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The packaged sidecar directory (the exe-adjacent layout).
pub(crate) fn packaged_runtime_dir() -> Option<PathBuf> {
    resolve_runtime_source_dir(&package_dir(), None)
}

pub(in crate::kernel::bootstrap) fn validate_runtime_source_dir(
    candidate: &Path,
) -> Option<PathBuf> {
    let candidate = candidate.canonicalize().ok()?;
    if !["package.json", "src/repl.ts"]
        .iter()
        .all(|file| candidate.join(file).is_file())
    {
        return None;
    }
    let manifest_raw = std::fs::read_to_string(candidate.join("package.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_raw).ok()?;
    (manifest.get("name")?.as_str()? == "prime-agent-runtime").then_some(candidate)
}

fn resolve_runtime_source_dir(package: &Path, checkout: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = vec![
        package.join("prime-agent-runtime"),
        package.join("dist").join("prime-agent-runtime"),
    ];
    if let Some(root) = checkout {
        candidates.push(root.join("prime-agent-runtime"));
    }
    candidates
        .into_iter()
        .find_map(|candidate| validate_runtime_source_dir(&candidate))
}

pub(crate) fn require_runtime_source_dir(override_dir: Option<&Path>) -> anyhow::Result<PathBuf> {
    if let Some(dir) = override_dir {
        return validate_runtime_source_dir(dir).with_context(|| {
            format!(
                "Invalid prime-agent-runtime source directory {}: expected package.json (name = \"prime-agent-runtime\") and src/repl.ts",
                dir.display()
            )
        });
    }
    resolve_runtime_source_dir(&package_dir(), crate::packages::source_checkout_root()).context(
        "Prime Agent requires a local prime-agent-runtime directory containing its package.json and src/repl.ts sources; reinstall Prime Agent with the runtime beside the binary, or set PI_PACKAGE_DIR to the complete trusted package directory.",
    )
}

/// Read the `dependencies` map declared in `source_dir/package.json`.
pub(crate) fn read_runtime_dependencies(
    source_dir: &Path,
) -> anyhow::Result<BTreeMap<String, String>> {
    let manifest_path = source_dir.join("package.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("reading {}", manifest_path.display()))?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("parsing {}", manifest_path.display()))?;
    let mut deps = BTreeMap::new();
    if let Some(obj) = parsed
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
    {
        for (name, version) in obj {
            let Some(version) = version.as_str() else {
                return Err(anyhow!(
                    "dependencies.{name} in {} must be a string",
                    manifest_path.display()
                ));
            };
            deps.insert(name.clone(), version.to_string());
        }
    }
    Ok(deps)
}

/// Hash `package.json`, `src/**/*.ts` (and `.js`/`.mjs`/`.cjs`), and `src/machines/**/*`
/// so any runtime source or machine-library change invalidates an existing `kernel-bun`.
pub(crate) fn hash_runtime_source(source_dir: &Path) -> anyhow::Result<String> {
    let src_dir = source_dir.join("src");
    let mut files = vec![source_dir.join("package.json")];
    collect_runtime_source_files(&src_dir, &mut files)?;
    collect_package_data_files(&src_dir.join("machines"), &mut files)?;
    files.sort();
    files.dedup();
    let mut hasher = sha2::Sha256::new();
    for file in &files {
        let relative = file.strip_prefix(source_dir)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(file)?);
        hasher.update([0]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn collect_runtime_source_files(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("machines") {
                continue;
            }
            collect_runtime_source_files(&path, files)?;
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| matches!(ext, "ts" | "js" | "mjs" | "cjs"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn collect_package_data_files(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_package_data_files(&path, files)?;
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_fixture(temp: &Path, machine_body: &str) -> anyhow::Result<()> {
        let src = temp.join("src");
        std::fs::create_dir_all(&src)?;
        std::fs::write(src.join("repl.ts"), "console.log('ready');\n")?;
        std::fs::write(src.join("factory.ts"), "export const X = 1;\n")?;
        let machines = src.join("machines").join("review-sweep");
        std::fs::create_dir_all(&machines)?;
        std::fs::write(machines.join("MACHINE.md"), machine_body)?;
        std::fs::write(
            temp.join("package.json"),
            r#"{"name":"prime-agent-runtime","type":"module","dependencies":{"acorn":"^8.18.0"}}"#,
        )?;
        Ok(())
    }

    #[test]
    fn missing_or_incomplete_runtime_sources_are_not_resolved() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let package = temp.path();
        assert_eq!(resolve_runtime_source_dir(package, None), None);
        let runtime = package.join("prime-agent-runtime");
        runtime_fixture(&runtime, "machine")?;
        for file in ["package.json", "src/repl.ts"] {
            let path = runtime.join(file);
            let contents = std::fs::read(&path)?;
            std::fs::remove_file(&path)?;
            assert_eq!(resolve_runtime_source_dir(package, None), None);
            std::fs::create_dir(&path)?;
            assert_eq!(resolve_runtime_source_dir(package, None), None);
            std::fs::remove_dir(&path)?;
            std::fs::write(&path, contents)?;
        }
        for manifest in ["not json", "{}", r#"{"name":"other"}"#] {
            std::fs::write(runtime.join("package.json"), manifest)?;
            assert_eq!(resolve_runtime_source_dir(package, None), None);
        }
        Ok(())
    }

    #[test]
    fn packaged_dist_and_checkout_sources_resolve_to_absolute_paths() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let package = temp.path().join("package");
        let checkout = temp.path().join("checkout");
        let direct = package.join("prime-agent-runtime");
        let dist = package.join("dist").join("prime-agent-runtime");
        let source = checkout.join("prime-agent-runtime");
        for runtime in [&source, &dist, &direct] {
            runtime_fixture(runtime, "machine")?;
            assert_eq!(
                resolve_runtime_source_dir(&package, Some(&checkout)),
                Some(runtime.canonicalize()?)
            );
        }
        std::fs::remove_file(direct.join("src/repl.ts"))?;
        assert_eq!(
            resolve_runtime_source_dir(&package, Some(&checkout)),
            Some(dist.canonicalize()?)
        );
        Ok(())
    }

    #[test]
    fn machine_library_changes_invalidate_the_runtime_identity() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        runtime_fixture(temp.path(), "---\nname: review-sweep\n")?;
        let before = hash_runtime_source(temp.path())?;
        runtime_fixture(temp.path(), "---\nname: review-sweep\nversion: 2\n")?;
        let after = hash_runtime_source(temp.path())?;
        assert_ne!(before, after, "a machine file change is a runtime change");

        std::fs::remove_dir_all(temp.path().join("src").join("machines"))?;
        let bare = hash_runtime_source(temp.path())?;
        assert_ne!(bare, after);
        Ok(())
    }
}
