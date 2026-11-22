//! RLM kernel layer: persistent Bun JavaScript REPL lifecycle.
//!
//! The kernel is a JSON-lines subprocess (`bun run src/repl.ts`): requests on
//! stdin, events on stdout, stderr kept as a diagnostics tail. The protocol is
//! documented in `prime-agent-runtime/src/repl.md` (protocol version 3).

pub mod bootstrap;
pub(crate) mod bun_env;
pub mod cancellation;
pub mod live_kernels;
pub mod manager;
pub mod orphan_journal;
pub mod protocol;
pub mod provisioner;
pub mod rlm_runtime;
pub mod shared;
pub mod state_snapshot;

pub use bootstrap::{
    build_rlm_bootstrap_code, ensure_kernel_bun, ensure_kernel_bun_for_project,
    invalidate_runtime_probe_cache, kernel_bun_dir, kernel_worker_entry,
    parse_unavailable_javascript_skills, EnsureKernelBunOptions, KernelBootstrapProgressHandler,
    KernelBunRuntime, KernelJavaScriptSkill, PreparedJavaScriptSkill, UnavailableJavaScriptSkills,
    JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER, MINIMUM_BUN_VERSION,
};
pub use cancellation::AbortSignal;
pub use manager::ReplKernelManager;
pub use provisioner::{JavaScriptKernelProvisioner, JavaScriptKernelProvisionerOptions};
pub use rlm_runtime::{
    create_default_rlm_subagent_session_name, find_rlm_model_matches,
    find_unique_rlm_short_form_model_match, format_rlm_model_unavailable_error,
    normalize_requested_rlm_subagent_model, normalize_requested_rlm_subagent_session_name,
    normalize_requested_rlm_subagent_thinking_level, RlmModelInfo, RlmModelMatch, THINKING_LEVELS,
};
pub use shared::{
    HostRequestHandler, HostRequestHandlers, HostRequestPayload, KernelDiffDisplay,
    KernelManagerOptions, KernelSentAgentMessage, KernelShutdownOptions, KernelSnapshotConfig,
    StreamName, EXECUTE_STATUS_ABORTED, EXECUTE_STATUS_ERROR, EXECUTE_STATUS_OK,
};
pub use state_snapshot::{manifest_path_in, snapshot_path_in, RestoreResult, SnapshotResult};

/// Environment for a Bun process: ambient Node/Bun preload overrides are
/// stripped before runtime initialization.
#[must_use]
pub fn bun_process_environment() -> std::collections::HashMap<std::ffi::OsString, std::ffi::OsString>
{
    bun_env::inherited_bun_env()
}
