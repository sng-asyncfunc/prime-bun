// Same bounded-boundary disposition as src/lib.rs: large_futures stack
// futures by design, too_many_lines is a style gate only, casts target
// 64-bit with narrowing at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Kernel bootstrap / lifecycle benchmark harness (verifier tooling, not a
//! test): measures cold and warm kernel bootstrap, per-execute overhead,
//! and snapshot/restore cost against a real `bun run src/repl.ts` child.
//! Modes: `ensure-bun`, `boot`, `snapshot-restore`.

use std::path::PathBuf;
use std::time::Instant;

use pa_core::kernel::bootstrap::{
    ensure_kernel_bun, EnsureKernelBunOptions, KernelBunRuntime, KernelJavaScriptSkill,
};
use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
    KernelShutdownOptions, KernelSnapshotConfig,
};
use pa_core::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

fn skills_dir() -> PathBuf {
    std::env::var("PA_BENCH_SKILLS_DIR").map_or_else(
        |_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills"),
        PathBuf::from,
    )
}

fn bench_javascript_skills() -> Vec<KernelJavaScriptSkill> {
    let dir = skills_dir();
    let loaded = pa_core::skills::load_skills_from_dir(&dir, "package");
    loaded
        .skills
        .into_iter()
        .filter_map(|skill| {
            let js = skill.javascript?;
            Some(KernelJavaScriptSkill {
                name: skill.name,
                global_name: js.global_name,
                entry_path: js.entry_path,
                package_path: js.package_path,
                package_json_path: js.package_json_path,
            })
        })
        .collect()
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

fn manager_options(
    runtime: &KernelBunRuntime,
    snapshot_dir: Option<&std::path::Path>,
) -> KernelManagerOptions {
    KernelManagerOptions {
        bun: Some(runtime.bun_path.clone()),
        worker_entry: Some(runtime.worker_entry.clone()),
        kernel_dir: Some(runtime.kernel_dir.clone()),
        cwd: Some(std::env::temp_dir()),
        env: std::collections::HashMap::default(),
        session_id: Some("kernel-bench".to_string()),
        host_handlers: HostRequestHandlers::new(),
        javascript_skills: bench_javascript_skills(),
        on_background_work_settled: None,
        snapshot: snapshot_dir.map(|dir| KernelSnapshotConfig {
            path: snapshot_path_in(dir),
            manifest_path: manifest_path_in(dir),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: Some(60_000),
        }),
        bootstrap_code: Some(pa_core::kernel::bootstrap::build_rlm_bootstrap_code(
            &runtime.prepared_skills,
            false,
        )),
        stderr_log_path: None,
    }
}

async fn boot_manager(options: &KernelManagerOptions) -> ReplKernelManager {
    let manager = ReplKernelManager::new(options.clone());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel start");
    let bootstrap = options.bootstrap_code.clone().expect("bootstrap present");
    let t = Instant::now();
    let result = manager.execute(&bootstrap, ExecuteOptions::default()).await;
    println!("bootstrap-execute-ms {}", ms(t));
    let result = result.expect("bootstrap execute");
    assert_eq!(result.status, ExecuteStatus::Ok, "bootstrap failed");
    manager
}

#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1).expect("mode argument");
    match mode.as_str() {
        "ensure-bun" => {
            let t = Instant::now();
            let runtime = ensure_kernel_bun(EnsureKernelBunOptions {
                javascript_skills: bench_javascript_skills(),
                on_progress: None,
                runtime_source_dir: None,
            })
            .await
            .expect("kernel bun");
            println!("ensure-kernel-bun-ms {}", ms(t));
            println!("bun {}", runtime.bun_path.display());
            println!("worker {}", runtime.worker_entry.display());
        }
        "boot" => {
            let snapshot_dir = std::env::var("PA_BENCH_SNAPSHOT_DIR")
                .map(PathBuf::from)
                .ok();
            let t = Instant::now();
            let runtime = ensure_kernel_bun(EnsureKernelBunOptions {
                javascript_skills: bench_javascript_skills(),
                on_progress: None,
                runtime_source_dir: None,
            })
            .await
            .expect("kernel bun");
            println!("ensure-kernel-bun-ms {}", ms(t));
            let t = Instant::now();
            let options = manager_options(&runtime, snapshot_dir.as_deref());
            let manager = boot_manager(&options).await;
            println!("kernel-boot-and-bootstrap-ms {}", ms(t));

            // Per-execute overhead: trivial cells on the warmed kernel.
            let rounds: u32 = std::env::var("PA_BENCH_EXEC_ROUNDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50);
            let t = Instant::now();
            for i in 0..rounds {
                let result = manager
                    .execute(
                        &format!("var x{i} = {i};"),
                        ExecuteOptions {
                            internal: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .expect("exec");
                assert_eq!(result.status, ExecuteStatus::Ok);
            }
            let total = ms(t);
            println!(
                "execute-rounds {rounds} total-ms {total} per-execute-ms {}",
                if rounds > 0 {
                    total / u64::from(rounds)
                } else {
                    0
                }
            );
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: false,
                    drain_host_requests: false,
                })
                .await;
        }
        "snapshot-restore" => {
            let snapshot_dir =
                std::env::var("PA_BENCH_SNAPSHOT_DIR").expect("PA_BENCH_SNAPSHOT_DIR");
            let runtime = ensure_kernel_bun(EnsureKernelBunOptions {
                javascript_skills: bench_javascript_skills(),
                on_progress: None,
                runtime_source_dir: None,
            })
            .await
            .expect("kernel bun");
            let options = manager_options(&runtime, Some(std::path::Path::new(&snapshot_dir)));
            let manager = boot_manager(&options).await;
            // ~5 MiB namespace: one large Uint8Array plus small scalars.
            manager
                .execute(
                    "const big = new Uint8Array(5 * 1024 * 1024);\nconst small = Array.from({ length: 100 }, (_, i) => i);\nconst name = 'bench';",
                    ExecuteOptions::default(),
                )
                .await
                .expect("seed namespace");

            let t = Instant::now();
            let snap = manager.snapshot_state().await.expect("snapshot");
            println!("snapshot-ms {}", ms(t));
            println!("snapshot-bytes {}", snap.bytes);
            println!("snapshot-saved {}", snap.saved.join(","));
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: false,
                    drain_host_requests: false,
                })
                .await;

            // Restore in a fresh kernel: cost + idempotence (restore twice,
            // the second must produce the same namespace state).
            let manager2 = boot_manager(&options).await;
            let t = Instant::now();
            let first = manager2.restore_state().await.expect("restore");
            println!("restore-ms {}", ms(t));
            println!("restore-restored {}", first.restored.join(","));
            let t = Instant::now();
            let second = manager2.restore_state().await.expect("second restore");
            println!("restore-idempotent-ms {}", ms(t));
            assert_eq!(
                first.restored, second.restored,
                "restore must be idempotent"
            );
            let check = manager2
                .execute(
                    "big.byteLength === 5 * 1024 * 1024 && name === 'bench'",
                    ExecuteOptions::default(),
                )
                .await
                .expect("check");
            assert_eq!(check.status, ExecuteStatus::Ok, "restored namespace usable");
            assert!(check.result.as_deref().is_some_and(|r| r.contains("true")));
            let _ = manager2
                .shutdown(KernelShutdownOptions {
                    snapshot: false,
                    drain_host_requests: false,
                })
                .await;
        }
        other => panic!("unknown mode {other}"),
    }
}
