// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Verifier integration tests: spawn a real `python -m rlm.repl` kernel
//! (the same JSON-lines protocol v3 runtime the TS product ships) and check
//! state persistence, kill -9 revival (unserializable objects are dropped
//! and reported), and the RLM bootstrap surface against the TS contract.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use pa_core::kernel::bootstrap::build_rlm_bootstrap_code;
use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelBashCommands, KernelManagerOptions,
    KernelShutdownOptions, KernelSnapshotConfig,
};
use pa_core::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

/// The kernel Bun binary with `prime-agent-runtime` available. Skipped (with a note) when absent;
/// `PA_CORE_KERNEL_BUN` points at an explicit executable instead.
fn kernel_bun() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_CORE_KERNEL_BUN") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_CORE_KERNEL_BUN {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let runtime_ready = pa_core::kernel::bootstrap::kernel_worker_entry(
        &pa_core::kernel::bootstrap::kernel_bun_dir(),
    )
    .is_file()
        || std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .is_some_and(|root| root.join("prime-agent-runtime/src/repl.ts").is_file());
    if !runtime_ready {
        eprintln!("prime-agent-runtime/src/repl.ts not found; skipping live kernel test");
        return None;
    }
    for candidate in [
        std::env::var_os("PRIME_AGENT_KERNEL_BUN").map(PathBuf::from),
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".bun/bin/bun")),
        Some(PathBuf::from("/usr/local/bin/bun")),
        Some(PathBuf::from("/usr/bin/bun")),
    ]
    .into_iter()
    .flatten()
    {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    eprintln!("bun executable not found; skipping live kernel test");
    None
}

/// Test options, or `None` when no Bun kernel runtime is available on this
/// machine (see [`kernel_bun`]); the caller skips the test then.
fn test_options(snapshot_dir: Option<&std::path::Path>) -> Option<KernelManagerOptions> {
    let bun = kernel_bun()?;
    Some(KernelManagerOptions {
        bun: Some(bun),
        worker_entry: None,
        kernel_dir: None,
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("integration-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        javascript_skills: Vec::new(),
        on_background_work_settled: None,
        snapshot: snapshot_dir.map(|dir| KernelSnapshotConfig {
            path: snapshot_path_in(dir),
            manifest_path: manifest_path_in(dir),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: None,
        }),
        // The provisioner always runs the RLM bootstrap after start; tests match that contract.
        bootstrap_code: Some(build_rlm_bootstrap_code(&[], false)),
        stderr_log_path: None,
    })
}

/// Start a manager and run the RLM bootstrap, mirroring the TS provisioner:
/// start, then `m.execute(bootstrapCode)` must be `ok`.
async fn started_manager(options: KernelManagerOptions) -> ReplKernelManager {
    let bootstrap = options
        .bootstrap_code
        .clone()
        .expect("tests always pass the RLM bootstrap");
    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let result = manager
        .execute(&bootstrap, ExecuteOptions::default())
        .await
        .expect("bootstrap execute must not fail");
    assert_eq!(
        result.status,
        ExecuteStatus::Ok,
        "rlm runtime bootstrap failed: {}",
        result.stderr
    );
    manager
}

async fn execute(
    manager: &ReplKernelManager,
    code: &str,
) -> pa_core::kernel::shared::ExecuteResult {
    let result = manager
        .execute(code, ExecuteOptions::default())
        .await
        .expect("execute must not fail");
    result
}

#[tokio::test]
async fn kernel_state_persists_across_cells_and_turns() {
    let Some(options) = test_options(None) else {
        return;
    };
    let manager = started_manager(options).await;

    let first = execute(
        &manager,
        "let x = 21;\nconst y = 'hello';\nconsole.log('defined');",
    )
    .await;
    assert_eq!(first.status, ExecuteStatus::Ok);
    assert_eq!(first.stdout.trim(), "defined");

    let second = execute(&manager, "x * 2").await;
    assert_eq!(second.status, ExecuteStatus::Ok);
    assert_eq!(
        second.result.as_deref(),
        Some("42"),
        "trailing expression value is captured"
    );

    // _ is bound to the last trailing expression value.
    let third = execute(&manager, "_ + 1").await;
    assert_eq!(third.result.as_deref(), Some("43"));

    // await works at top level across turns.
    let fourth = execute(
        &manager,
        "const result = await Promise.resolve('done');\nresult",
    )
    .await;
    assert_eq!(fourth.result.as_deref(), Some("\"done\""));

    // Error cells report ename/evalue/traceback, and state survives them.
    let error = execute(&manager, "throw new TypeError('boom')").await;
    assert_eq!(error.status, ExecuteStatus::Error);
    let kernel_error = error.error.expect("error cell carries the kernel error");
    assert_eq!(kernel_error.ename, "TypeError");
    assert!(!kernel_error.traceback.is_empty());
    let after = execute(&manager, "x").await;
    assert_eq!(after.result.as_deref(), Some("21"));

    let shutdown = manager.shutdown(KernelShutdownOptions::default()).await;
    assert!(shutdown.is_ok());
}

#[tokio::test]
async fn background_timer_output_is_separated_from_cell_output() {
    let Some(options) = test_options(None) else {
        return;
    };
    let manager = started_manager(options).await;
    // A timer writing after its cell finished lands in background output.
    let first = execute(
        &manager,
        "setTimeout(() => console.log('late from timer'), 300);\nconsole.log('from cell');",
    )
    .await;
    assert_eq!(first.stdout.trim(), "from cell");
    assert_eq!(first.status, ExecuteStatus::Ok);

    let second = execute(&manager, "await Bun.sleep(500)").await;
    assert!(
        second
            .background_output
            .as_deref()
            .unwrap_or_default()
            .contains("late from timer"),
        "late timer output surfaces as background output, got {:?}",
        second.background_output
    );
    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn rlm_bootstrap_injects_the_kernel_surface() {
    let Some(base) = test_options(None) else {
        return;
    };
    let options = KernelManagerOptions {
        bootstrap_code: Some(build_rlm_bootstrap_code(&[], false)),
        ..base
    };
    let manager = started_manager(options).await;

    let result = execute(
        &manager,
        "typeof rlm.spawn === 'function' && typeof rlm.findModels === 'function' && typeof rlm.harness === 'object' && typeof bash === 'function' && typeof rlm.getHarnessState === 'function'",
    )
    .await;
    assert_eq!(
        result.status,
        ExecuteStatus::Ok,
        "bootstrap must bind the RLM surface"
    );
    assert_eq!(
        result.result.as_deref(),
        Some("true"),
        "rlm/bash/harness must be usable"
    );

    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn host_requests_round_trip_to_registered_handlers() {
    let mut handlers = HostRequestHandlers::new();
    handlers.register(
        "rlm.find_models",
        pa_core::kernel::shared::host_handler(|payload| async move {
            assert_eq!(payload.data["query"], "glm");
            assert_eq!(payload.data["limit"], 2);
            Ok(serde_json::json!({
                "models": [
                    {"provider": "pi", "id": "glm-5.3", "name": "GLM", "selector": "pi/glm-5.3"}
                ]
            }))
        }),
    );
    let Some(base) = test_options(None) else {
        return;
    };
    let options = KernelManagerOptions {
        host_handlers: handlers,
        bootstrap_code: Some(build_rlm_bootstrap_code(&[], false)),
        ..base
    };
    let manager = started_manager(options).await;

    // rlm.findModels runs through the runtime's hostRequest bridge; the
    // host reply must reach the awaiting cell.
    let result = execute(
        &manager,
        "const found = await rlm.findModels('glm', 2);\nfound[0].selector",
    )
    .await;
    assert_eq!(result.status, ExecuteStatus::Ok, "cell: {:?}", result.error);
    assert_eq!(result.result.as_deref(), Some("\"pi/glm-5.3\""));

    // An unregistered request type fails the cell with the unavailable-handler error.
    let error = execute(&manager, "await rlm.hostRequest('nope.custom', {})").await;
    assert_eq!(error.status, ExecuteStatus::Error);
    let message = error
        .error
        .as_ref()
        .map(|kernel_error| kernel_error.evalue.as_str())
        .unwrap_or_default();
    assert!(
        message.contains("not available in this session"),
        "expected unavailable-handler error, got stderr {:?} error {:?}",
        error.stderr,
        error.error
    );

    // rlm.endTurn needs no registration: the manager answers it before the
    // registry lookup, marks the executing cell, and the flag rides the settled result.
    let ended = execute(&manager, "const endRes = await rlm.endTurn();\nendRes").await;
    assert_eq!(ended.status, ExecuteStatus::Ok, "cell: {:?}", ended.error);
    assert!(
        ended
            .result
            .as_deref()
            .unwrap_or_default()
            .contains("endedTurn"),
        "ended result: {:?}",
        ended.result
    );
    assert!(
        ended.ended_turn,
        "the end-turn flag must ride the settled result"
    );

    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn kill9_then_restart_revives_snapshot_and_reports_unserializable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let manager = started_manager(options).await;

    // Serializable variables plus one unserializable object (a function / closure) across separate turns.
    execute(
        &manager,
        "let answer = 42;\nconst items = ['a', 'b'];\nconst nonSer = new WeakMap();",
    )
    .await;
    execute(&manager, "answer += 0;").await; // second turn touches the namespace

    // Flush a snapshot so the namespace is durable before the kill.
    let snapshot = tokio::time::timeout(Duration::from_secs(15), manager.snapshot_state())
        .await
        .expect("snapshot must settle")
        .expect("snapshot must run while the kernel is up");
    assert!(
        snapshot.saved.contains(&"answer".to_string()),
        "saved: {:?}",
        snapshot.saved
    );
    assert!(
        snapshot.skipped.iter().any(|skip| skip.name == "nonSer"),
        "a WeakMap must be skipped and reported, got: {:?}",
        snapshot.skipped
    );

    let pid = manager.process_id().expect("kernel pid");
    assert!(pid > 0);
    // kill -9 the kernel process, like a host OOM/infra kill.
    let _ =
        pa_core::platform::process::kill_pid(pid as i32, pa_core::platform::process::Signal::Kill);
    for _ in 0..100 {
        if manager.is_defunct() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(manager.is_defunct(), "killed kernel must settle defunct");

    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let revived = started_manager(options).await;
    let restore = tokio::time::timeout(Duration::from_secs(15), revived.restore_state())
        .await
        .expect("restore must settle");
    let restore = restore.expect("restore must run");
    assert!(
        restore.restored.contains(&"answer".to_string())
            && restore.restored.contains(&"items".to_string()),
        "restored: {:?}",
        restore.restored
    );

    let check = execute(&revived, "answer").await;
    assert_eq!(check.result.as_deref(), Some("42"));
    let items = execute(&revived, "JSON.stringify(items)").await;
    assert_eq!(items.result.as_deref(), Some("\"[\\\"a\\\",\\\"b\\\"]\""));
    let missing = execute(&revived, "typeof nonSer === 'undefined'").await;
    assert_eq!(
        missing.result.as_deref(),
        Some("true"),
        "nonSer must be dropped"
    );

    revived
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await
        .expect("shutdown");
}

/// Background `bash()` handles hold kernel residency, and a held
/// continuation waits for their settlement: its completion settles the
/// track exactly once; a graceful teardown over the settled track fires nothing.
#[tokio::test]
async fn background_bash_settlement_fires_the_callback_once() {
    let Some(mut options) = test_options(None) else {
        return;
    };
    let settled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&settled);
    let settled_notify = std::sync::Arc::new(tokio::sync::Notify::new());
    let notify = std::sync::Arc::clone(&settled_notify);
    options.on_background_work_settled = Some(std::sync::Arc::new(move || {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        notify.notify_one();
    }));
    let manager = started_manager(options).await;

    execute(&manager, "const live = bash('sleep 600');").await;
    assert!(
        manager.has_background_work(),
        "the handle must register on the activity track"
    );
    assert_eq!(settled.load(std::sync::atomic::Ordering::SeqCst), 0);

    execute(&manager, "live.kill();").await;
    let notified = settled_notify.notified();
    tokio::time::timeout(Duration::from_secs(10), notified)
        .await
        .expect("the settlement callback must fire");
    assert!(
        !manager.has_background_work(),
        "the handle's completion must settle the track"
    );
    assert_eq!(settled.load(std::sync::atomic::Ordering::SeqCst), 1);

    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
    assert_eq!(settled.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn kernel_teardown_with_live_handles_settles_the_callback_once() {
    let Some(mut options) = test_options(None) else {
        return;
    };
    let settled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&settled);
    options.on_background_work_settled = Some(std::sync::Arc::new(move || {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    let manager = started_manager(options).await;

    execute(&manager, "const first = bash('sleep 600');").await;
    execute(&manager, "const second = bash('sleep 600');").await;
    assert!(manager.has_background_work());
    assert_eq!(settled.load(std::sync::atomic::Ordering::SeqCst), 0);

    manager.kill();
    assert!(!manager.has_background_work());
    assert_eq!(settled.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cell_result_summarizes_the_bash_commands_it_ran() {
    let Some(options) = test_options(None) else {
        return;
    };
    let manager = started_manager(options).await;

    let result = execute(
        &manager,
        "async function runCmd(cmd) { return await bash(cmd); }\nawait runCmd(\"echo one\\necho two\");\nawait bash(\"true\");",
    )
    .await;

    assert_eq!(result.status, ExecuteStatus::Ok);
    assert_eq!(
        result.bash_commands,
        Some(KernelBashCommands {
            first: "echo one\necho two".to_string(),
            count: 2,
            lines: 3,
        })
    );
    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn graceful_shutdown_flushes_the_final_snapshot() {
    let dir = tempfile::tempdir().expect("tempdir");
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let manager = started_manager(options).await;
    execute(&manager, "const persisted = 'value';\n").await;

    // shutdown({snapshot: true}) must flush the namespace without an explicit snapshot call.
    let performed = tokio::time::timeout(
        Duration::from_secs(15),
        manager.shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        }),
    )
    .await
    .expect("shutdown must settle");
    assert!(performed.expect("shutdown result"));

    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let revived = started_manager(options).await;
    let restore = revived
        .restore_state()
        .await
        .expect("restore after graceful shutdown");
    assert!(
        restore.restored.contains(&"persisted".to_string()),
        "graceful shutdown must persist the namespace, got {:?}",
        restore.restored
    );
    revived
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}
