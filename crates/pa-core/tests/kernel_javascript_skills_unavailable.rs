// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Verifier integration tests for the JavaScript-skills-unavailable notice: a
//! kernel boot whose bootstrap fails to load a configured JavaScript skill
//! reports it through `onUnavailableSkills`; the session-level row rides
//! the next admitted turn.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_core::kernel::bootstrap::{KernelJavaScriptSkill, UnavailableJavaScriptSkills};
use pa_core::kernel::provisioner::{
    JavaScriptKernelProvisioner, JavaScriptKernelProvisionerOptions,
};
use pa_core::kernel::shared::HostRequestHandlers;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use pa_core::session_engine::skills_unavailable_notice::{
    notice_message, JAVASCRIPT_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
};
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use pa_types::session::FileEntry;

/// The faux provider registry is process-global and the session test
/// drives it: the std lock serializes the contenders (the only ones).
static FAUX_LOCK: Mutex<()> = Mutex::new(());

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
        || std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .is_some_and(|root| root.join("prime-agent-runtime/src/repl.ts").is_file());
    if !runtime_ready {
        eprintln!("prime-agent-runtime/src/repl.ts not found; skipping live notice test");
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
    eprintln!("bun executable not found; skipping live notice test");
    None
}

/// One boot with an explicit kernel Bun reports the broken skill load (and only it).
#[tokio::test]
async fn broken_skill_import_reports_and_healthy_skills_stay_silent() {
    let Some(bun) = kernel_bun() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let healthy_dir = dir.path().join("healthy-skill");
    std::fs::create_dir_all(healthy_dir.join("src")).expect("healthy dir");
    let healthy_entry = healthy_dir.join("src/index.ts");
    let healthy_pkg = healthy_dir.join("package.json");
    std::fs::write(
        &healthy_pkg,
        r#"{"name":"healthy-skill","primeAgent":{"entry":"src/index.ts","global":"healthySkill"}}"#,
    )
    .expect("pkg");
    std::fs::write(
        &healthy_entry,
        "export function createSkill() { return { ping: () => 'pong' }; }\n",
    )
    .expect("entry");

    let reported: Arc<Mutex<Vec<UnavailableJavaScriptSkills>>> = Arc::new(Mutex::new(Vec::new()));
    let on_unavailable_skills = {
        let reported = Arc::clone(&reported);
        Arc::new(move |errors: &UnavailableJavaScriptSkills| {
            reported.lock().unwrap().push(errors.clone());
        }) as pa_core::kernel::provisioner::UnavailableSkillsCallback
    };
    let provisioner = JavaScriptKernelProvisioner::new(
        "/tmp",
        JavaScriptKernelProvisionerOptions {
            bun: Some(bun),
            host_handlers: HostRequestHandlers::new(),
            javascript_skills: vec![
                KernelJavaScriptSkill {
                    name: "broken-skill-lane".to_string(),
                    global_name: "brokenSkillLane".to_string(),
                    entry_path: PathBuf::from("/nonexistent/skill/src/index.ts"),
                    package_path: PathBuf::from("/nonexistent/skill"),
                    package_json_path: PathBuf::from("/nonexistent/skill/package.json"),
                },
                KernelJavaScriptSkill {
                    name: "healthy-skill".to_string(),
                    global_name: "healthySkill".to_string(),
                    entry_path: healthy_entry,
                    package_path: healthy_dir,
                    package_json_path: healthy_pkg,
                },
            ],
            on_unavailable_skills: Some(on_unavailable_skills),
            ..Default::default()
        },
    );
    provisioner
        .ensure(None, None)
        .await
        .expect("the broken skill must not cost the kernel");
    let reported = reported.lock().unwrap().clone();
    assert_eq!(reported.len(), 1, "reported: {reported:?}");
    assert_eq!(
        reported[0].len(),
        1,
        "healthySkill must stay out: {reported:?}"
    );
    assert_eq!(reported[0][0].0, "brokenSkillLane");
    provisioner.dispose(None).await;
}

/// The notice rides the next admitted turn as model context: the
/// durable row keeps the multi-skill content and `details.skills`.
#[tokio::test]
// The faux lock is held across the turn's awaits (see `FAUX_LOCK`).
#[allow(clippy::await_holding_lock)]
async fn notice_rides_the_next_turn_as_model_context() {
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");

    let provider_saw_notice = Arc::new(Mutex::new(false));
    let seen_provider = Arc::clone(&provider_saw_notice);
    let responses = vec![pa_ai::faux::FauxResponseStep::Factory(Arc::new(
        move |context: &pa_types::ai::Context,
              _options: Option<&pa_ai::types::StreamOptions>,
              _call: u64,
              _model: &pa_types::ai::Model| {
            let saw = context.messages.iter().any(|message| {
                matches!(message, pa_types::ai::Message::User(user) if user
                    .content
                    .text()
                    .contains("failed to load into the Bun kernel"))
            });
            *seen_provider.lock().unwrap() = saw;
            Ok(pa_ai::faux::faux_assistant_text_message(
                "queued turn complete",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        },
    ))];
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
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

    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(json_round_trip(&model).expect("model conversion")),
        stream_fn: Some(stream_fn),
        tools: Vec::new(),
        ..Default::default()
    })
    .await
    .expect("create the session");

    let errors: UnavailableJavaScriptSkills = vec![
        (
            "websearch".to_string(),
            "Cannot find module 'websearch'".to_string(),
        ),
        ("edit".to_string(), "boom".to_string()),
    ];
    engine.session.queue_next_turn_row(notice_message(&errors));

    let outcome = engine
        .prompt("go", PromptOptions::default())
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    assert!(
        *provider_saw_notice.lock().unwrap(),
        "the model must see the report on the same turn"
    );
    let entries = engine.session.entries().await;
    let notice = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == JAVASCRIPT_SKILLS_UNAVAILABLE_CUSTOM_TYPE =>
            {
                Some(payload.clone())
            }
            _ => None,
        })
        .expect("the notice must land durably");
    assert!(notice.display, "the notice is user-visible");
    assert_eq!(
        notice.details,
        Some(serde_json::json!({ "skills": ["websearch", "edit"] }))
    );
    let pa_types::ai::UserContent::Text(content) = &notice.content else {
        panic!("text content");
    };
    assert!(
        content.contains("- websearch: Cannot find module 'websearch'"),
        "{content}"
    );
    assert!(content.contains("- edit: boom"), "{content}");
}
