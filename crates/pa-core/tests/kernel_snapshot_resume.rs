// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Verifier integration tests for the kernel snapshot lifecycle: a persisted session leaves a
//! `kernel-state.dill` snapshot, and a resumed session prewarms from the snapshot alone so its
//! first `ipython` call sees the old variables. The kernel Python is ambient; skipped if absent.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use pa_ai::faux::{
    faux_assistant_message, register_faux_provider, FauxAssistantMessageOptions,
    FauxModelDefinition, FauxResponseStep, RegisterFauxProviderOptions,
};
use pa_core::session::manager::SessionManager;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use pa_core::session_engine::state_restore_notice::JAVASCRIPT_STATE_RESTORED_CUSTOM_TYPE;
use pa_core::session_engine::telemetry::{build_client, TelemetryWiring};
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use pa_core::settings::SettingsManager;
use pa_types::session::FileEntry;

/// The faux provider registry is process-global and the tests drive it:
/// the std lock serializes them (the only contenders).
static FAUX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The kernel Bun binary with `prime-agent-runtime` available; skipped with a note when absent.
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
        || Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .is_some_and(|root| root.join("prime-agent-runtime/src/repl.ts").is_file());
    if !runtime_ready {
        eprintln!("prime-agent-runtime/src/repl.ts not found; skipping live snapshot test");
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
    eprintln!("bun executable not found; skipping live snapshot test");
    None
}

/// One faux provider session: the model and its stream function, with the
/// scripted responses queued.
struct FauxSession {
    model: pa_types::ai::Model,
    stream_fn: pa_agent::stream::StreamFn,
}

fn faux_session(responses: Vec<FauxResponseStep>) -> FauxSession {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        models: Some(vec![FauxModelDefinition {
            id: "faux-1".to_string(),
            name: Some("Faux".to_string()),
            reasoning: Some(false),
            input: Some(vec![pa_types::ai::ModelInput::Text]),
            cost: None,
            context_window: Some(100_000),
            max_tokens: Some(4_096),
        }]),
        ..Default::default()
    });
    registration.set_responses(responses);
    let model = registration.get_model();
    let stream_fn = real_stream_fn(None, model.clone());
    FauxSession { model, stream_fn }
}

/// One assistant turn that calls the `javascript` tool with `code` (the
/// loop's tool-call shape: `StopReason::ToolUse` + a `ToolCall` block).
fn javascript_tool_call_step(call_id: &str, code: &str) -> FauxResponseStep {
    let message = faux_assistant_message(
        vec![pa_types::ai::AssistantContentBlock::ToolCall(
            pa_types::ai::ToolCall {
                id: call_id.to_string(),
                name: "javascript".to_string(),
                arguments: serde_json::json!({ "code": code })
                    .as_object()
                    .cloned()
                    .expect("object"),
                thought_signature: None,
                rest: serde_json::Map::default(),
            },
        )],
        FauxAssistantMessageOptions {
            stop_reason: Some(pa_types::ai::StopReason::ToolUse),
            ..Default::default()
        },
    );
    FauxResponseStep::Message(message)
}

fn text_step(text: &str) -> FauxResponseStep {
    pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
        text,
        FauxAssistantMessageOptions::default(),
    ))
}

fn agent_model(model: &pa_types::ai::Model) -> pa_agent::types::Model {
    json_round_trip(model).expect("model conversion")
}

/// Wait for the session's kernel to boot: running, and (for a revived
/// boot, `cold: false`) with the snapshot restore applied.
async fn wait_for_boot(engine: &pa_core::session_engine::engine::SessionEngine, cold: bool) {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        if let Some(provisioner) = engine.kernel_provisioner_weak().upgrade() {
            if provisioner.has_running_kernel() && (cold || provisioner.last_restore().is_some()) {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the kernel never reported a cold={cold} boot"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The text of every `ToolResult` message the loop carries (the model-side
/// view of an ipython cell's output).
async fn tool_result_texts(engine: &pa_core::session_engine::engine::SessionEngine) -> Vec<String> {
    let state = engine.session.agent().state().await;
    state
        .messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(
                result,
            )) => Some(
                result
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        pa_agent::types::ToolResultContent::Text(text) => Some(text.text.clone()),
                        pa_agent::types::ToolResultContent::Image(_) => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect()
}

/// Drive one prompt to idle and return the loop's settled messages.
async fn run_turn(engine: &pa_core::session_engine::engine::SessionEngine, text: &str) {
    let outcome = engine
        .prompt(text, PromptOptions::default())
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;
}

/// The session test fixtures: isolated agent dir, sessions dir, cwd, and the telemetry client.
struct Fixture {
    dir: tempfile::TempDir,
    agent_dir: PathBuf,
    sessions_dir: PathBuf,
    cwd: PathBuf,
    client: pa_telemetry::TelemetryClient,
}

fn fixture() -> Fixture {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let settings = SettingsManager::create(&cwd, &agent_dir);
    let client = build_client(&settings, &agent_dir);
    Fixture {
        dir,
        agent_dir,
        sessions_dir,
        cwd,
        client,
    }
}

impl Fixture {
    fn engine_config(
        &self,
        session_manager: SessionManager,
        faux: &FauxSession,
    ) -> SessionEngineConfig {
        SessionEngineConfig {
            steering_mode: None,
            follow_up_mode: None,
            cwd: self.cwd.clone(),
            agent_dir: self.agent_dir.clone(),
            model: Some(agent_model(&faux.model)),
            stream_fn: Some(faux.stream_fn.clone()),
            tools: Vec::new(),
            session_manager: Some(session_manager),
            telemetry: Some(TelemetryWiring {
                client: self.client.clone(),
                execution_mode: Some("test".to_string()),
                now: None,
                telemetry_enabled: None,
            }),
            ..Default::default()
        }
    }
}

/// The full lifecycle: a session defines kernel state and ends, a resumed session prewarms with the
/// config flag OFF, and its FIRST ipython call sees the old namespace.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn session_end_then_resume_prewarms_and_revives_the_namespace() {
    let Some(_kernel_bun) = kernel_bun() else {
        return;
    };
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = fixture();

    let faux_one = faux_session(vec![
        javascript_tool_call_step(
            "call-setup",
            "const data = { n: 42 };\nconst marker = 'lane-snapshot';\nfs.mkdirSync('moved', { recursive: true });\nprocess.chdir('moved');\nprocess.env.PA_RESTORE_PROBE = 'set';\nconsole.log('setup done');",
        ),
        text_step("state defined"),
    ]);
    let session_manager = SessionManager::persisted(&fixture.cwd, &fixture.sessions_dir);
    let session_id = session_manager.get_session_id().to_string();
    let session_file = session_manager
        .get_session_file()
        .expect("persisted session file")
        .to_path_buf();
    let engine = create_session(fixture.engine_config(session_manager, &faux_one))
        .await
        .expect("create the first session");
    run_turn(&engine, "set up the data").await;
    let results = tool_result_texts(&engine).await;
    assert!(
        results.iter().any(|text| text.contains("setup done")),
        "the setup cell must have run: {results:?}"
    );
    engine.dispose_kernel().await;

    // The snapshot landed in the session's artifact dir.
    let artifact_dir = fixture
        .dir
        .path()
        .join("session-artifacts")
        .join(&session_id);
    let snapshot = artifact_dir.join("kernel-state.bin");
    assert!(
        snapshot.exists(),
        "kernel-state.bin must exist in the session artifact dir after dispose"
    );
    drop(engine);

    // Session two: RESUME with the prewarm config flag off; only `hasSnapshot` may fire the boot.
    let faux_two = faux_session(vec![
        javascript_tool_call_step(
            "call-read",
            "console.log(marker);\nconsole.log(process.cwd());\nconsole.log(String(process.env.PA_RESTORE_PROBE));",
        ),
        text_step("read back"),
    ]);
    let resumed_manager = SessionManager::open(&fixture.cwd, &fixture.sessions_dir, &session_file);
    assert_eq!(
        resumed_manager.get_session_id(),
        session_id,
        "the resumed session keeps its identity (and artifact dir)"
    );
    let session_open = Instant::now();
    let resumed = create_session(fixture.engine_config(resumed_manager, &faux_two))
        .await
        .expect("resume the session");
    // The benchmark dimension: session-open to first-cell readiness with
    // the namespace restored — the boot (spawn + restore + bootstrap)
    // completes here, BEFORE any prompt, so the first ipython call is a
    // warm hit. `cold: false` is the revived-boot report (a snapshot
    // existed to restore).
    wait_for_boot(&resumed, false).await;
    let ready_elapsed = session_open.elapsed();
    // The warm-hit bound: the boot finished before this assertion ran; a
    // generous ceiling only (the sandbox may be loaded), the structural
    // claim is "ready before the first prompt", proven by the boot.
    assert!(
        ready_elapsed < Duration::from_mins(1),
        "resume boot took too long: {ready_elapsed:?}"
    );

    // The first ipython call in the resumed session sees the old
    // variables WITHOUT re-running the setup cell.
    run_turn(&resumed, "read the marker back").await;
    let results = tool_result_texts(&resumed).await;
    assert!(
        results.iter().any(|text| text.contains("lane-snapshot")),
        "the resumed namespace must revive: {results:?}"
    );

    // Bun runtime snapshots preserve `process.cwd()` and `process.env` deltas across resume.
    let read_back = results
        .iter()
        .find(|text| text.contains("lane-snapshot"))
        .expect("the resumed read cell ran");
    let moved_cwd = fixture
        .cwd
        .join("moved")
        .canonicalize()
        .expect("canonicalize the moved cwd");
    assert!(
        read_back
            .lines()
            .any(|line| Path::new(line.trim()) == moved_cwd.as_path()),
        "the resumed Bun kernel must restore the saved cwd: {read_back}"
    );
    assert!(
        read_back.lines().any(|line| line.trim() == "set"),
        "the probe env var must be restored: {read_back}"
    );

    // The restore notice rode the turn and landed durably, naming what came back.
    let entries = resumed.session.entries().await;
    let notice = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == JAVASCRIPT_STATE_RESTORED_CUSTOM_TYPE =>
            {
                Some(payload.clone())
            }
            _ => None,
        })
        .expect("the javascript_state_restored notice must land on the resumed session");
    let pa_types::ai::UserContent::Text(content) = &notice.content else {
        panic!("the notice content is text");
    };
    assert!(content.contains("[javascript-state-restored]"), "{content}");
    assert!(
        content.contains("revived from your previous session"),
        "{content}"
    );
    assert!(
        content.contains("marker"),
        "the notice names what returned: {content}"
    );
    assert_eq!(
        notice.details,
        Some(serde_json::json!({ "restored": true })),
        "the notice's details flag the revive"
    );
    assert!(notice.display, "the notice is user-visible");
    resumed.dispose_kernel().await;
}

/// The prewarm arm does not over-fire: a FRESH session (no snapshot) with
/// the config flag off stays lazy — no boot.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn fresh_session_without_snapshot_stays_lazy_without_the_flag() {
    let Some(_kernel_bun) = kernel_bun() else {
        return;
    };
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = fixture();
    let faux = faux_session(vec![text_step("ok")]);
    let session_manager = SessionManager::persisted(&fixture.cwd, &fixture.sessions_dir);
    let engine = create_session(fixture.engine_config(session_manager, &faux))
        .await
        .expect("create the lazy session");

    // Long enough for a wrongly-fired prewarm to boot and report; the lazy session reports nothing.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        assert!(
            !engine
                .kernel_provisioner_weak()
                .upgrade()
                .is_some_and(|provisioner| provisioner.has_running_kernel()),
            "a fresh session without a snapshot must not prewarm"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
