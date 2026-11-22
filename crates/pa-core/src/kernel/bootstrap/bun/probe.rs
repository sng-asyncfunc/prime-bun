//! In-process and cross-process (`disk_memo`) readiness memo for `kernel-bun`.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use crate::kernel::bootstrap::disk_memo::{
    disk_memo_hit, disk_memo_invalidate, disk_memo_path, disk_memo_write,
};

use super::version::{bootstrap_version_current, read_bootstrap_version_raw};

const PROBE_MEMO_CAP: usize = 16;

static RUNTIME_PROBE_MEMO: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static LAST_KERNEL_DIR: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn lock_probe_memo() -> std::sync::MutexGuard<'static, Option<HashSet<String>>> {
    RUNTIME_PROBE_MEMO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Drop the memoized runtime-ready verdict (in-process and on disk) so the next
/// startup re-checks the staged `kernel-bun` directory.
pub fn invalidate_runtime_probe_cache() {
    if let Some(memo) = lock_probe_memo().as_mut() {
        memo.clear();
    }
    let last_dir = LAST_KERNEL_DIR
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(dir) = last_dir {
        let _ = disk_memo_invalidate(&disk_memo_path(&dir));
    }
    let default_dir = super::layout::kernel_bun_dir();
    let _ = disk_memo_invalidate(&disk_memo_path(&default_dir));
}

pub(crate) fn runtime_probe_key(
    bun_path: &Path,
    bun_version: &str,
    runtime_identity: &str,
    bootstrap_raw: &str,
    kernel_dir: &Path,
) -> String {
    let worker_mtime = std::fs::metadata(kernel_dir.join("src").join("repl.ts"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!(
        "{}\0{bun_version}\0{runtime_identity}\0{bootstrap_raw}\0{}\0{worker_mtime}",
        bun_path.display(),
        kernel_dir.display()
    )
}

pub(crate) fn kernel_runtime_ready(
    bun_path: &Path,
    bun_version: &str,
    kernel_dir: &Path,
    runtime_identity: &str,
    expected_deps: &BTreeMap<String, String>,
) -> bool {
    let (version, raw) = read_bootstrap_version_raw(kernel_dir);
    if !bootstrap_version_current(
        version.as_ref(),
        runtime_identity,
        expected_deps,
        kernel_dir,
    ) {
        return false;
    }
    let key = runtime_probe_key(bun_path, bun_version, runtime_identity, &raw, kernel_dir);
    {
        let mut last = LAST_KERNEL_DIR
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *last = Some(kernel_dir.to_path_buf());
    }
    {
        let memo = lock_probe_memo();
        if memo.as_ref().is_some_and(|set| set.contains(&key)) {
            return true;
        }
    }
    let disk_path = disk_memo_path(kernel_dir);
    if disk_memo_hit(&disk_path, &key) {
        record_in_process_hit(key);
        return true;
    }
    // Version file + files on disk already matched: record the verdict.
    record_in_process_hit(key.clone());
    disk_memo_write(&disk_path, &key);
    true
}

fn record_in_process_hit(key: String) {
    let mut memo = lock_probe_memo();
    let set = memo.get_or_insert_with(HashSet::new);
    if set.len() >= PROBE_MEMO_CAP {
        set.clear();
    }
    set.insert(key);
}
