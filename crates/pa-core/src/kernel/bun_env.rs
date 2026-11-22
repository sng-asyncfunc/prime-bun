//! Bun subprocess environment: inherited path overrides must not turn a
//! repository into runtime startup code before the user has acted.

use std::collections::HashMap;
#[cfg(any(not(windows), test))]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Reject executable search paths inside the opened repository, even when the
/// session cwd is a subdirectory. An ancestor can also expose project files.
fn path_starts_with(path: &Path, project: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive, including when the input uses
        // different casing from the spelling returned by canonicalize.
        let project = project.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        let project = Path::new(&project);
        let path = Path::new(&path);
        path.starts_with(project)
    }
    #[cfg(not(windows))]
    {
        path.starts_with(project)
    }
}

fn paths_overlap(path: &Path, project: &Path) -> bool {
    path_starts_with(path, project) || path_starts_with(project, path)
}

pub(crate) fn safe_path(path: &Path, project: Option<&Path>) -> bool {
    safe_path_with_mode(path, project, false)
}

/// An ancestor PATH entry is safe for direct executable lookup only when the
/// selected executable itself resolves outside the project.
pub(crate) fn safe_executable_path(path: &Path, project: Option<&Path>) -> bool {
    safe_path_with_mode(path, project, true)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    path_starts_with(left, right) && path_starts_with(right, left)
}

fn safe_path_with_mode(path: &Path, project: Option<&Path>, allow_ancestor: bool) -> bool {
    let Some(project) = project else {
        return false;
    };
    let Ok(project) = project.canonicalize() else {
        return false;
    };
    let repository_roots: Vec<_> = project
        .ancestors()
        .filter(|ancestor| ancestor.join(".git").exists())
        .collect();
    if !path.is_absolute() {
        return false;
    }
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    // An unmarked filesystem root is not a repository. Requiring a candidate
    // outside it would reject every installed executable on that volume.
    if repository_roots.is_empty() && project.parent().is_none() {
        return true;
    }
    let boundaries = if repository_roots.is_empty() {
        vec![project.as_path()]
    } else {
        repository_roots
    };
    !boundaries.into_iter().any(|boundary| {
        if allow_ancestor {
            path_starts_with(path, boundary) || path_starts_with(&canonical_path, boundary)
        } else {
            paths_overlap(path, boundary) || paths_overlap(&canonical_path, boundary)
        }
    })
}

/// The single global Bun install at `~/.bun/bin/bun` is a trusted executable
/// even when the launch boundary is the home directory itself, as long as
/// `HOME` is the account's own home. No other HOME path receives this exception.
pub(crate) fn safe_home_bun(path: &Path, project: Option<&Path>) -> bool {
    safe_home_bun_with_home(
        path,
        project,
        pa_types::platform::home_dir().as_deref(),
        account_home().as_deref(),
    )
}

/// The account's home from the user database, independent of `HOME`.
#[cfg(unix)]
fn account_home() -> Option<PathBuf> {
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.dir)
}

/// No dependency exposes the profile known folder, so Windows takes
/// `USERPROFILE`.
#[cfg(not(unix))]
fn account_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|profile| !profile.is_empty())
        .map(PathBuf::from)
}

fn safe_home_bun_with_home(
    path: &Path,
    project: Option<&Path>,
    home: Option<&Path>,
    account_home: Option<&Path>,
) -> bool {
    let (Some(project), Some(home)) = (project, home) else {
        return false;
    };
    let (Ok(project), Ok(canonical_home)) = (project.canonicalize(), home.canonicalize()) else {
        return false;
    };
    let bun_bin_dir = home.join(".bun").join("bin");
    let Ok(canonical_bin_dir) = bun_bin_dir.canonicalize() else {
        return false;
    };
    let bun_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let Ok(canonical_bun) = path.canonicalize() else {
        return false;
    };
    if !path.is_absolute()
        || !paths_equal(path, &bun_bin_dir.join(bun_name))
        || !paths_equal(&canonical_bin_dir, &canonical_home.join(".bun").join("bin"))
        || !paths_equal(&canonical_bun, &canonical_bin_dir.join(bun_name))
    {
        return false;
    }
    let nearest_checkout = project
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists());
    // An unmarked filesystem root is not a repository boundary. Mirrors
    // safe_path_with_mode: a first-time setup launched from `/` must still
    // find the home Bun.
    if nearest_checkout.is_none() && project.parent().is_none() {
        return true;
    }
    let active_boundary = nearest_checkout.unwrap_or(&project);
    let home_is_account_home = account_home
        .and_then(|account_home| account_home.canonicalize().ok())
        .is_some_and(|account_home| paths_equal(&account_home, &canonical_home));
    (home_is_account_home && paths_equal(active_boundary, &canonical_home))
        || !path_starts_with(&canonical_bun, active_boundary)
}

/// Drop ambient Node/Bun preload & module-search overrides after caller
/// overrides are applied so a repository cannot inject startup code into the
/// Bun worker before the user has acted.
pub(crate) fn sanitize_bun_env(env: &mut HashMap<OsString, OsString>) {
    for name in ["NODE_OPTIONS", "NODE_PATH", "BUN_PRELOAD"] {
        let keys: Vec<_> = env
            .keys()
            .filter(|key| {
                #[cfg(windows)]
                {
                    key.to_string_lossy().eq_ignore_ascii_case(name)
                }
                #[cfg(not(windows))]
                {
                    key.as_os_str() == OsStr::new(name)
                }
            })
            .cloned()
            .collect();
        for key in keys {
            env.remove(&key);
        }
    }
}

pub(crate) fn inherited_bun_env() -> HashMap<OsString, OsString> {
    let mut env = std::env::vars_os().collect();
    sanitize_bun_env(&mut env);
    env
}

/// Filter `PATH` entries for `bun install` subprocesses so relative or
/// repository-local binaries cannot hijack lifecycle scripts or tool lookups.
pub(crate) fn sanitize_bun_path(env: &mut HashMap<OsString, OsString>, project: Option<&Path>) {
    let keys: Vec<_> = env
        .keys()
        .filter(|key| {
            #[cfg(windows)]
            {
                key.to_string_lossy().eq_ignore_ascii_case("PATH")
            }
            #[cfg(not(windows))]
            {
                key.as_os_str() == OsStr::new("PATH")
            }
        })
        .cloned()
        .collect();
    let entries: Vec<_> = keys
        .iter()
        .filter_map(|key| env.get(key))
        .flat_map(|value| std::env::split_paths(value))
        .filter(|path| safe_path(path, project))
        .collect();
    for key in keys {
        env.remove(&key);
    }
    if !entries.is_empty() {
        if let Ok(value) = std::env::join_paths(entries) {
            env.insert(OsString::from("PATH"), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bun_preload_overrides_are_removed_after_options_overlay() {
        let mut env = HashMap::from([
            (
                OsString::from("NODE_OPTIONS"),
                OsString::from("--require=./x"),
            ),
            (
                OsString::from("NODE_PATH"),
                OsString::from("/repo/node_modules"),
            ),
            (OsString::from("BUN_PRELOAD"), OsString::from("./evil.ts")),
            (OsString::from("NO_COLOR"), OsString::from("1")),
        ]);
        #[cfg(not(windows))]
        env.insert(OsString::from("node_options"), OsString::from("untouched"));
        #[cfg(windows)]
        env.insert(
            OsString::from("node_options"),
            OsString::from("--require=./y"),
        );

        sanitize_bun_env(&mut env);
        for name in ["NODE_OPTIONS", "NODE_PATH", "BUN_PRELOAD"] {
            assert!(!env
                .keys()
                .any(|key| key.to_string_lossy().eq_ignore_ascii_case(name)
                    && (cfg!(windows) || key.as_os_str() == OsStr::new(name))));
        }
        assert_eq!(env.get(OsStr::new("NO_COLOR")), Some(&OsString::from("1")));
        #[cfg(not(windows))]
        assert_eq!(
            env.get(OsStr::new("node_options")),
            Some(&OsString::from("untouched"))
        );
    }

    #[test]
    fn executable_search_rejects_repository_sibling_paths() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let project = repo.join("app");
        let sibling = repo.join("tools");
        let trusted = root.path().join("trusted");
        for dir in [&project, &sibling, &trusted] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::create_dir(repo.join(".git")).unwrap();
        assert!(!safe_path(&sibling, Some(&project)));
        assert!(safe_path(&trusted, Some(&project)));
        #[cfg(unix)]
        {
            let alias = root.path().join("alias");
            std::os::unix::fs::symlink(&project, &alias).unwrap();
            assert!(!safe_path(&sibling, Some(&alias)));
        }

        let mut env = HashMap::from([(
            OsString::from("PATH"),
            std::env::join_paths([Path::new("."), &sibling, &trusted]).unwrap(),
        )]);
        sanitize_bun_path(&mut env, Some(&project));
        assert_eq!(
            env.get(OsStr::new("PATH")),
            Some(&trusted.as_os_str().to_os_string())
        );

        let mut unresolved = HashMap::from([(
            OsString::from("PATH"),
            std::env::join_paths([&trusted]).unwrap(),
        )]);
        sanitize_bun_path(&mut unresolved, None);
        assert!(!unresolved.contains_key(OsStr::new("PATH")));
    }

    #[test]
    fn filesystem_root_without_git_allows_the_home_bun() {
        let root = tempfile::tempdir().unwrap();
        let filesystem_root = root.path().ancestors().last().unwrap();
        if filesystem_root.join(".git").exists() {
            return;
        }
        let home = root.path().join("home");
        let tool_dir = home.join(".bun").join("bin");
        let bun_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        let bun = tool_dir.join(bun_name);
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(&bun, "bun").unwrap();
        assert!(safe_home_bun_with_home(
            &bun,
            Some(filesystem_root),
            Some(&home),
            Some(&home)
        ));
    }

    #[test]
    fn only_the_direct_home_bun_is_trusted() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let tool_dir = home.join(".bun").join("bin");
        let bun_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        let bun = tool_dir.join(bun_name);
        let untrusted = home.join("tools");
        let untrusted_bun = untrusted.join(bun_name);
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::create_dir_all(&untrusted).unwrap();
        std::fs::write(&bun, "bun").unwrap();
        std::fs::write(&untrusted_bun, "bun").unwrap();
        assert!(safe_home_bun_with_home(
            &bun,
            Some(&home),
            Some(&home),
            Some(&home)
        ));
        assert!(!safe_home_bun_with_home(
            &untrusted_bun,
            Some(&home),
            Some(&home),
            Some(&home)
        ));
        assert!(!safe_home_bun_with_home(
            &bun,
            Some(&home),
            Some(&home),
            None
        ));
        #[cfg(unix)]
        {
            std::fs::remove_file(&bun).unwrap();
            std::fs::remove_dir(&tool_dir).unwrap();
            std::os::unix::fs::symlink(&untrusted, &tool_dir).unwrap();
            assert!(!safe_home_bun_with_home(
                &bun,
                Some(&home),
                Some(&home),
                Some(&home)
            ));
            std::fs::remove_file(&tool_dir).unwrap();
            std::fs::create_dir(&tool_dir).unwrap();
            std::fs::write(&bun, "bun").unwrap();
        }
        std::fs::create_dir(home.join(".git")).unwrap();
        assert!(safe_home_bun_with_home(
            &bun,
            Some(&home),
            Some(&home),
            Some(&home)
        ));
        let nested = home.join("project");
        let nested_tools = nested.join("tools");
        std::fs::create_dir_all(&nested_tools).unwrap();
        std::fs::create_dir(nested.join(".git")).unwrap();
        assert!(safe_home_bun_with_home(
            &bun,
            Some(&nested),
            Some(&home),
            Some(&home)
        ));
        assert!(!safe_executable_path(&untrusted_bun, Some(&nested)));
        assert!(!safe_home_bun_with_home(
            &untrusted_bun,
            Some(&nested),
            Some(&home),
            Some(&home)
        ));
        assert!(!safe_home_bun_with_home(
            &nested_tools.join(bun_name),
            Some(&nested),
            Some(&home),
            Some(&home)
        ));
    }

    #[test]
    fn home_bun_redirected_into_a_repository_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let account = root.path().join("account");
        let repo = root.path().join("repo");
        let home = repo.join("home");
        let project = repo.join("app");
        let bun_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        let bun = home.join(".bun").join("bin").join(bun_name);
        let root_bun = repo.join(".bun").join("bin").join(bun_name);
        std::fs::create_dir_all(&account).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(bun.parent().unwrap()).unwrap();
        std::fs::create_dir_all(root_bun.parent().unwrap()).unwrap();
        std::fs::write(&bun, "bun").unwrap();
        std::fs::write(&root_bun, "bun").unwrap();
        for launch in [&project, &home] {
            assert!(!safe_home_bun_with_home(
                &bun,
                Some(launch),
                Some(&home),
                Some(&account)
            ));
        }
        for launch in [&repo, &project] {
            assert!(!safe_home_bun_with_home(
                &root_bun,
                Some(launch),
                Some(&repo),
                Some(&account)
            ));
        }
    }

    #[test]
    fn filesystem_root_without_git_allows_absolute_bun_paths() {
        let root = tempfile::tempdir().unwrap();
        let filesystem_root = root.path().ancestors().last().unwrap();
        if filesystem_root.join(".git").exists() {
            return;
        }
        let tool = root.path().join("bun");
        std::fs::write(&tool, "bun").unwrap();
        assert!(safe_executable_path(&tool, Some(filesystem_root)));
        assert!(safe_path(root.path(), Some(filesystem_root)));
        assert!(!safe_executable_path(
            Path::new("bun"),
            Some(filesystem_root)
        ));
    }
}
