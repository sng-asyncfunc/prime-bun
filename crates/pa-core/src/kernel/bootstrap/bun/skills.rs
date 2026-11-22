//! Per-skill JavaScript dependency provisioning under
//! `<kernel_bun_dir>/skill-deps/<hash>/generations/<uuid>/`.
//!
//! Zero-dependency skills return their canonicalized source paths directly with
//! zero copying or install cost. Skills with `dependencies` or
//! `optionalDependencies` get an isolated, content-addressed `node_modules`
//! generation plus an immutable source snapshot (including sibling `_shared/`).
//! Per-skill failures populate `unavailable_reason` instead of aborting kernel
//! startup.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context};
use sha2::Digest;

use super::run_bun_install;
use super::version::write_atomic;
use crate::kernel::bootstrap::dir_lock::acquire_bootstrap_lock;
use crate::kernel::bootstrap::{
    EnsureKernelBunOptions, KernelJavaScriptSkill, PreparedJavaScriptSkill,
};

const SKILL_DEPENDENCY_STATE_FILE: &str = ".skill-dependencies.json";
const MAX_SKILL_UNAVAILABLE_REASON_CHARS: usize = 512;

fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => text[..idx].to_string(),
        None => text.to_string(),
    }
}

fn assert_path_inside_package(
    package_path: &Path,
    file_path: &Path,
    label: &str,
) -> anyhow::Result<()> {
    let Ok(relative) = file_path.strip_prefix(package_path) else {
        return Err(anyhow!(
            "JavaScript skill {label} {} must stay inside {}",
            file_path.display(),
            package_path.display()
        ));
    };
    if relative.as_os_str().is_empty()
        || relative.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!(
            "JavaScript skill {label} {} must stay inside {}",
            file_path.display(),
            package_path.display()
        ));
    }
    Ok(())
}

fn canonicalize_skill(skill: &KernelJavaScriptSkill) -> anyhow::Result<KernelJavaScriptSkill> {
    let package_path = skill
        .package_path
        .canonicalize()
        .with_context(|| format!("canonicalizing skill dir {}", skill.package_path.display()))?;
    let entry_path = skill
        .entry_path
        .canonicalize()
        .with_context(|| format!("canonicalizing skill entry {}", skill.entry_path.display()))?;
    let package_json_path = skill.package_json_path.canonicalize().with_context(|| {
        format!(
            "canonicalizing skill package.json {}",
            skill.package_json_path.display()
        )
    })?;
    assert_path_inside_package(&package_path, &entry_path, "entry")?;
    assert_path_inside_package(&package_path, &package_json_path, "package metadata")?;
    Ok(KernelJavaScriptSkill {
        name: skill.name.clone(),
        global_name: skill.global_name.clone(),
        entry_path,
        package_path,
        package_json_path,
    })
}

fn read_dependency_record(
    value: Option<&serde_json::Value>,
    label: &str,
    package_json_path: &Path,
) -> anyhow::Result<BTreeMap<String, String>> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let Some(obj) = value.as_object() else {
        return Err(anyhow!(
            "{label} in {} must be an object",
            package_json_path.display()
        ));
    };
    let mut deps = BTreeMap::new();
    for (name, version) in obj {
        let Some(version) = version.as_str().filter(|v| !v.trim().is_empty()) else {
            return Err(anyhow!(
                "{label}.{name} in {} must be a non-empty string",
                package_json_path.display()
            ));
        };
        deps.insert(name.clone(), version.to_string());
    }
    Ok(deps)
}

fn normalize_skill_dependency_spec(specifier: &str, package_path: &Path) -> String {
    let Some(target) = specifier.strip_prefix("file:") else {
        return specifier.to_string();
    };
    if target.is_empty() || Path::new(target).is_absolute() || target.starts_with("//") {
        return specifier.to_string();
    }
    let resolved = package_path.join(target);
    let normalized = resolved.canonicalize().unwrap_or(resolved);
    format!("file:{}", normalized.display())
}

fn read_skill_dependencies(
    skill: &KernelJavaScriptSkill,
) -> anyhow::Result<BTreeMap<String, String>> {
    let raw = std::fs::read_to_string(&skill.package_json_path)
        .with_context(|| format!("reading {}", skill.package_json_path.display()))?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("parsing {}", skill.package_json_path.display()))?;
    if !parsed.is_object() {
        return Err(anyhow!(
            "JavaScript skill package {} must be an object",
            skill.package_json_path.display()
        ));
    }
    let mut deps = read_dependency_record(
        parsed.get("dependencies"),
        "dependencies",
        &skill.package_json_path,
    )?;
    let optional_deps = read_dependency_record(
        parsed.get("optionalDependencies"),
        "optionalDependencies",
        &skill.package_json_path,
    )?;
    for (name, spec) in optional_deps {
        deps.insert(name, spec);
    }
    Ok(deps
        .into_iter()
        .map(|(name, spec)| {
            (
                name,
                normalize_skill_dependency_spec(&spec, &skill.package_path),
            )
        })
        .collect())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillDependencyState {
    generation: String,
    signature: String,
    package_json_path: String,
}

fn current_skill_dependency_generation(cache_dir: &Path, signature: &str) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(cache_dir.join(SKILL_DEPENDENCY_STATE_FILE)).ok()?;
    let state: SkillDependencyState = serde_json::from_str(&raw).ok()?;
    if state.signature != signature {
        return None;
    }
    if state.generation.is_empty()
        || !state
            .generation
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return None;
    }
    let generation_dir = cache_dir.join("generations").join(&state.generation);
    generation_dir
        .join("node_modules")
        .is_dir()
        .then_some(generation_dir)
}

fn copy_dir_filtered(src: &Path, dst: &Path, skip_git: bool) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == "node_modules" || (skip_git && name_str == ".git") {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        // Follow symlinks (dereference), matching ref-prime-bun `cp(..., { dereference: true })`.
        let meta = std::fs::metadata(&src_path)
            .with_context(|| format!("reading metadata for {}", src_path.display()))?;
        if meta.is_dir() {
            copy_dir_filtered(&src_path, &dst_path, skip_git)?;
        } else if meta.is_file() {
            std::fs::copy(&src_path, &dst_path).with_context(|| {
                format!("copying {} -> {}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}

fn copy_skill_source(dst_root: &Path, skill: &KernelJavaScriptSkill) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst_root)?;
    let pkg_name = skill.package_path.file_name().ok_or_else(|| {
        anyhow!(
            "skill package path has no basename: {}",
            skill.package_path.display()
        )
    })?;
    copy_dir_filtered(&skill.package_path, &dst_root.join(pkg_name), true)?;
    if let Some(parent) = skill.package_path.parent() {
        let shared = parent.join("_shared");
        if shared.is_dir() {
            copy_dir_filtered(&shared, &dst_root.join("_shared"), false)?;
        }
    }
    Ok(())
}

fn hash_skill_source_dir(root: &Path) -> anyhow::Result<String> {
    fn visit(dir: &Path, rel: &Path, hasher: &mut sha2::Sha256) -> anyhow::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let name = entry.file_name();
            let rel_path = if rel.as_os_str().is_empty() {
                PathBuf::from(&name)
            } else {
                rel.join(&name)
            };
            let path = entry.path();
            let meta = std::fs::metadata(&path)?;
            if meta.is_dir() {
                hasher.update(b"directory\0");
                hasher.update(rel_path.to_string_lossy().as_bytes());
                hasher.update([0]);
                visit(&path, &rel_path, hasher)?;
            } else if meta.is_file() {
                hasher.update(b"file\0");
                hasher.update(rel_path.to_string_lossy().as_bytes());
                hasher.update([0]);
                hasher.update(std::fs::read(&path)?);
                hasher.update([0]);
            } else {
                return Err(anyhow!(
                    "JavaScript skill source contains unsupported entry {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let mut hasher = sha2::Sha256::new();
    visit(root, Path::new(""), &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn prepared_skill_paths(
    source_dir: &Path,
    skill: &KernelJavaScriptSkill,
) -> anyhow::Result<PreparedJavaScriptSkill> {
    let relative_entry = skill.entry_path.strip_prefix(&skill.package_path)?;
    let pkg_name = skill
        .package_path
        .file_name()
        .ok_or_else(|| anyhow!("skill package path has no basename"))?;
    let pkg_json_name = skill
        .package_json_path
        .file_name()
        .ok_or_else(|| anyhow!("skill package.json has no basename"))?;
    let package_path = source_dir.join(pkg_name);
    Ok(PreparedJavaScriptSkill {
        name: skill.name.clone(),
        global_name: skill.global_name.clone(),
        entry_path: package_path.join(relative_entry),
        package_json_path: package_path.join(pkg_json_name),
        package_path,
        unavailable_reason: None,
    })
}

fn prepare_immutable_skill_source(
    generation_dir: &Path,
    skill: &KernelJavaScriptSkill,
) -> anyhow::Result<PreparedJavaScriptSkill> {
    let tmp_source = generation_dir.join(format!(
        ".source.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        copy_skill_source(&tmp_source, skill)?;
        let content_hash = hash_skill_source_dir(&tmp_source)?;
        let source_dir = generation_dir.join("sources").join(content_hash);
        if !source_dir.exists() {
            if let Some(parent) = source_dir.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if let Err(error) = std::fs::rename(&tmp_source, &source_dir) {
                if !source_dir.exists() {
                    return Err(error).with_context(|| {
                        format!("publishing skill source {}", source_dir.display())
                    });
                }
            }
        }
        prepared_skill_paths(&source_dir, skill)
    })();
    let _ = std::fs::remove_dir_all(&tmp_source);
    result
}

async fn provision_skill_dependency_cache(
    bun_path: &Path,
    kernel_dir: &Path,
    skill: &KernelJavaScriptSkill,
    dependencies: &BTreeMap<String, String>,
    project: Option<&Path>,
) -> anyhow::Result<PreparedJavaScriptSkill> {
    if dependencies.is_empty() {
        return Ok(PreparedJavaScriptSkill::from_skill(skill.clone(), None));
    }
    let identity = serde_json::json!({
        "packageJsonPath": skill.package_json_path.to_string_lossy(),
        "dependencies": dependencies,
    })
    .to_string();
    let digest = format!("{:x}", sha2::Sha256::digest(identity.as_bytes()));
    let signature = format!("sha256:{digest}");
    let prefix = &digest[..31.min(digest.len())];
    let cache_dir = kernel_dir.join("skill-deps").join(prefix);
    let _lock = acquire_bootstrap_lock(&cache_dir).await?;

    if let Some(current_gen) = current_skill_dependency_generation(&cache_dir, &signature) {
        return prepare_immutable_skill_source(&current_gen, skill);
    }

    let generation = uuid::Uuid::new_v4().to_string();
    let generations_root = cache_dir.join("generations");
    let generation_dir = generations_root.join(&generation);
    let tmp_generation = generations_root.join(format!(".{generation}.{}.tmp", std::process::id()));

    let install_result = async {
        std::fs::create_dir_all(&tmp_generation)?;
        let pkg_json = serde_json::to_string_pretty(&serde_json::json!({
            "private": true,
            "dependencies": dependencies,
        }))?;
        write_atomic(
            &tmp_generation.join("package.json"),
            &format!("{pkg_json}\n"),
        )?;
        run_bun_install(bun_path, &tmp_generation, project).await?;
        std::fs::rename(&tmp_generation, &generation_dir).with_context(|| {
            format!(
                "publishing skill dependency generation {}",
                generation_dir.display()
            )
        })?;
        let state = SkillDependencyState {
            generation: generation.clone(),
            signature: signature.clone(),
            package_json_path: skill.package_json_path.to_string_lossy().into_owned(),
        };
        write_atomic(
            &cache_dir.join(SKILL_DEPENDENCY_STATE_FILE),
            &format!("{}\n", serde_json::to_string(&state)?),
        )?;
        prepare_immutable_skill_source(&generation_dir, skill)
    }
    .await;

    if tmp_generation.exists() {
        let _ = std::fs::remove_dir_all(&tmp_generation);
    }
    install_result
}

/// Prepare every JavaScript skill for the Bun worker. Per-skill failures never
/// abort kernel startup; instead they set `unavailable_reason`.
pub(crate) async fn prepare_javascript_skills(
    bun_path: &Path,
    kernel_dir: &Path,
    skills: &[KernelJavaScriptSkill],
    options: &EnsureKernelBunOptions,
    project: Option<&Path>,
) -> Vec<PreparedJavaScriptSkill> {
    let mut prepared = Vec::with_capacity(skills.len());
    for skill in skills {
        match prepare_one_skill(bun_path, kernel_dir, skill, project).await {
            Ok(ready) => prepared.push(ready),
            Err(error) => {
                let message = format!(
                    "JavaScript skill {} dependencies are unavailable: {error:#}",
                    skill.name
                );
                options.report(&format!("! {message}"));
                prepared.push(PreparedJavaScriptSkill::from_skill(
                    skill.clone(),
                    Some(truncate_chars(&message, MAX_SKILL_UNAVAILABLE_REASON_CHARS)),
                ));
            }
        }
    }
    prepared
}

async fn prepare_one_skill(
    bun_path: &Path,
    kernel_dir: &Path,
    skill: &KernelJavaScriptSkill,
    project: Option<&Path>,
) -> anyhow::Result<PreparedJavaScriptSkill> {
    let canonical = canonicalize_skill(skill)?;
    let dependencies = read_skill_dependencies(&canonical)?;
    provision_skill_dependency_cache(bun_path, kernel_dir, &canonical, &dependencies, project).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn zero_dependency_skill_returns_canonical_paths_without_copying() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("edit");
        std::fs::create_dir_all(skill_dir.join("src")).unwrap();
        std::fs::write(
            skill_dir.join("package.json"),
            r#"{"name":"edit","primeAgent":{"global":"edit","entry":"src/index.ts"}}"#,
        )
        .unwrap();
        std::fs::write(skill_dir.join("src/index.ts"), "export default () => {};\n").unwrap();
        let kernel_dir = dir.path().join("kernel-bun");
        std::fs::create_dir_all(&kernel_dir).unwrap();

        let skill = KernelJavaScriptSkill {
            name: "edit".into(),
            global_name: "edit".into(),
            entry_path: skill_dir.join("src/index.ts"),
            package_path: skill_dir.clone(),
            package_json_path: skill_dir.join("package.json"),
        };
        let prepared = prepare_javascript_skills(
            Path::new("/nonexistent/bun"),
            &kernel_dir,
            &[skill],
            &EnsureKernelBunOptions::default(),
            None,
        )
        .await;
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].unavailable_reason, None);
        assert_eq!(
            prepared[0].entry_path,
            skill_dir.join("src/index.ts").canonicalize().unwrap()
        );
        assert!(!kernel_dir.join("skill-deps").exists());
    }

    #[tokio::test]
    async fn escaping_symlink_entry_is_marked_unavailable_without_failing_batch() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.ts");
        std::fs::write(&outside, "export default 1;\n").unwrap();
        let skill_dir = dir.path().join("bad");
        std::fs::create_dir_all(skill_dir.join("src")).unwrap();
        std::fs::write(
            skill_dir.join("package.json"),
            r#"{"name":"bad","primeAgent":{"global":"bad","entry":"src/index.ts"}}"#,
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, skill_dir.join("src/index.ts")).unwrap();
        #[cfg(not(unix))]
        std::fs::write(skill_dir.join("src/index.ts"), "export default 1;\n").unwrap();

        let kernel_dir = dir.path().join("kernel-bun");
        std::fs::create_dir_all(&kernel_dir).unwrap();
        let skill = KernelJavaScriptSkill {
            name: "bad".into(),
            global_name: "bad".into(),
            entry_path: skill_dir.join("src/index.ts"),
            package_path: skill_dir.clone(),
            package_json_path: skill_dir.join("package.json"),
        };
        let prepared = prepare_javascript_skills(
            Path::new("/nonexistent/bun"),
            &kernel_dir,
            &[skill],
            &EnsureKernelBunOptions::default(),
            None,
        )
        .await;
        assert_eq!(prepared.len(), 1);
        #[cfg(unix)]
        assert!(
            prepared[0]
                .unavailable_reason
                .as_deref()
                .is_some_and(|r| r.contains("must stay inside")),
            "{:?}",
            prepared[0].unavailable_reason
        );
    }
}
