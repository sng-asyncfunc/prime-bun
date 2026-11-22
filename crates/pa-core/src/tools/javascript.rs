//! The `javascript` tool: persistent Bun JavaScript/TypeScript REPL execution
//! through a kernel — the model-facing definition, result text composition, and
//! timeout handling. Kernel process management lives behind the
//! [`JavaScriptKernelProvisioner`] trait, owned by the kernel manager module.

use std::fmt::Write as _;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::json;

use crate::settings::types::DEFAULT_JAVASCRIPT_CELL_TIMEOUT_MS;

mod diff;
use crate::tools::tool_definition::{
    AbortSignal, ExecutionMode, OnUpdate, ToolContentBlock, ToolDefinition, ToolExecutionResult,
    ToolUpdate,
};
use diff::generate_diff_string;

/// Mime types the model context accepts as images.
pub const IMAGE_MIME_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Kernel execution types

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KernelErrorInfo {
    pub ename: String,
    pub evalue: String,
    pub traceback: Vec<String>,
}

/// A media attachment loaded into context (e.g. by the attach-image skill).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelAttachment {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ExecuteStatus {
    #[default]
    Ok,
    Error,
    Aborted,
}

#[derive(Debug, Clone, Default)]
pub struct ExecuteResult {
    pub status: ExecuteStatus,
    pub stdout: String,
    pub stderr: String,
    pub result: Option<String>,
    pub duration_ms: Option<u64>,
    /// Output that arrived without this cell's id, shown separately.
    pub background_output: Option<String>,
    pub error: Option<KernelErrorInfo>,
    pub attachments: Vec<KernelAttachment>,
    /// File edits displayed by this cell, in order.
    pub diffs: Vec<crate::kernel::shared::KernelDiffDisplay>,
    /// Agent messages sent from this cell, in order (`sentAgentMessages` on the
    /// tool-result details).
    pub sent_agent_messages: Vec<crate::kernel::shared::KernelSentAgentMessage>,
    /// The `bash()` commands this cell started, summarized for display
    /// (`bashCommands` on the tool-result details).
    pub bash_commands: Option<crate::kernel::shared::KernelBashCommands>,
    /// The cell's `rlm.session.messages` reads (`transcriptReads` on the
    /// tool-result details).
    pub transcript_reads: Vec<serde_json::Value>,
    /// The time limit that interrupted this cell, if one did.
    pub timed_out_after_ms: Option<u64>,
    /// The cell ended the turn via the sanctioned `rlm.endTurn()` call:
    /// the host marked the execution, and this result terminates the tool
    /// batch (the "turn ended" note on the tool-result text).
    pub ended_turn: bool,
}

/// The wire form of one sent agent message (`KernelSentAgentMessage`):
/// `id`, `message`, `deliveryStatus`, `receiverRole` when present, and the
/// `target` endpoint (`sessionName` only when present).
#[must_use]
pub fn sent_agent_message_json(
    sent: &crate::kernel::shared::KernelSentAgentMessage,
) -> serde_json::Value {
    use crate::kernel::shared::{SentAgentMessageTarget, SentDeliveryStatus};
    let crate::kernel::shared::KernelSentAgentMessage {
        id,
        message,
        delivery_status,
        receiver_role,
        target:
            SentAgentMessageTarget {
                active_session_id,
                session_id,
                session_name,
            },
    } = sent;
    let delivery = match delivery_status {
        SentDeliveryStatus::Delivered => "delivered",
        SentDeliveryStatus::Queued => "queued",
    };
    let mut value = json!({
        "id": id,
        "message": message,
        "deliveryStatus": delivery,
        "target": {
            "activeSessionId": active_session_id,
            "sessionId": session_id,
        },
    });
    if let Some(role) = receiver_role {
        value["receiverRole"] = json!(role.as_str());
    }
    if let Some(name) = session_name {
        value["target"]["sessionName"] = json!(name);
    }
    value
}

pub type StreamFn<'a> = Option<&'a (dyn Fn(&str, &'static str) + Send + Sync)>;

pub type LateSentAgentMessageHandler =
    std::sync::Arc<dyn Fn(&str, crate::kernel::shared::KernelSentAgentMessage) + Send + Sync>;

pub struct KernelExecuteOptions<'a> {
    pub signal: Option<AbortSignal>,
    /// The model's per-call `timeout`, clamped to the allowed range; `None`
    /// keeps the session's default limit.
    pub timeout_ms: Option<u64>,
    /// Streams cell output while the cell runs.
    pub on_stream: StreamFn<'a>,
    pub on_late_sent_agent_message: Option<crate::kernel::shared::LateSentAgentMessageCallback>,
}

type ExecuteCellFuture = Pin<Box<dyn Future<Output = anyhow::Result<ExecuteResult>> + Send>>;

/// A running kernel able to execute code cells.
pub trait KernelExecutor: Send + Sync {
    /// Execute one cell in the persistent kernel.
    fn execute(&self, code: &str, options: KernelExecuteOptions<'_>) -> ExecuteCellFuture;
}

/// Startup progress handler (`KernelBootstrapProgressHandler`).
pub type BootstrapProgressHandler = Arc<dyn Fn(&str) + Send + Sync>;

type EnsureFuture = Pin<Box<dyn Future<Output = anyhow::Result<Box<dyn KernelExecutor>>> + Send>>;

/// Owns the lazy create+start+bootstrap of one session's Bun JavaScript kernel.
/// Implementations memoize one running kernel (concurrent `ensure` calls await
/// the same in-flight startup; a failed startup clears the memo), and `kill`
/// terminates the kernel losing all in-memory state. Object-safe on purpose.
pub trait JavaScriptKernelProvisioner: Send + Sync {
    /// Start (or reuse) the kernel; resolves once it is ready to execute.
    fn ensure(
        &self,
        on_progress: Option<BootstrapProgressHandler>,
        signal: Option<AbortSignal>,
    ) -> EnsureFuture;

    /// Kill the kernel immediately, losing all in-memory state.
    fn kill(&self) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

#[must_use]
pub fn kernel_restart_notice() -> &'static str {
    "<javascript_kernel_reset>\nThe Bun JavaScript kernel was restarted after a previous interrupted cell kept running. Variables, imports, pending promises, and open resources from before the restart are no longer available; recreate them before using them.\n</javascript_kernel_reset>"
}

// Tool definition

/// Turn kernel image attachments into image blocks; non-images are dropped.
#[must_use]
pub fn image_blocks_from_attachments(attachments: &[KernelAttachment]) -> Vec<ToolContentBlock> {
    attachments
        .iter()
        .filter(|a| IMAGE_MIME_TYPES.contains(&a.mime_type.as_str()))
        .map(|a| ToolContentBlock::Image {
            data: a.data.clone(),
            mime_type: a.mime_type.clone(),
        })
        .collect()
}

fn format_execute_text(
    result: &ExecuteResult,
    background_output: Option<&str>,
    kernel_restarted: bool,
) -> String {
    let mut text = result.stdout.clone();
    if !result.stderr.is_empty() {
        text.push_str(if text.is_empty() { "" } else { "\n" });
        text.push_str(&result.stderr);
    }
    if let Some(result_text) = &result.result {
        text.push_str(if text.is_empty() { "" } else { "\n" });
        text.push_str(result_text);
    }
    if let Some(limit_ms) = result.timed_out_after_ms {
        text.push_str(if text.is_empty() { "" } else { "\n" });
        text.push_str(&cell_timeout_message(limit_ms, kernel_restarted));
    } else if result.status == ExecuteStatus::Error {
        if let Some(error) = &result.error {
            text.push_str(if text.is_empty() { "" } else { "\n" });
            text.push_str(&error.traceback.join("\n"));
        }
    }
    if let Some(background) = background_output {
        let separator = if text.is_empty() { "" } else { "\n" };
        let _ = write!(
            text,
            "{separator}[background output (unattributed)]\n{background}"
        );
    }
    text
}

/// The model-facing cause and fix for a cell interrupted at its time limit.
fn cell_timeout_message(limit_ms: u64, kernel_restarted: bool) -> String {
    let mut message = format!(
        "This cell was interrupted after {}: long blocking work stops the session. Make it \
non-blocking: start long shell commands with `const handle = bash(...)` (inspect with \
`handle.poll()` / `handle.tail()` in later cells) or keep async promises non-blocking instead of \
holding a single cell open. A cell that legitimately needs longer can pass a larger `timeout` \
(max {JAVASCRIPT_REPL_TIMEOUT_MAX_S} s), but long work belongs in background handles or async tasks.",
        humanize_ms(limit_ms)
    );
    if kernel_restarted {
        message.push_str(" The cell did not stop on the interrupt, so the kernel was restarted.");
    }
    message
}

/// Milliseconds as one plain reading: whole seconds when the value divides,
/// a decimal otherwise, raw milliseconds under one second.
fn humanize_ms(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms.is_multiple_of(1000) {
        format!("{}s", ms / 1000)
    } else {
        format!("{}.{:03}s", ms / 1000, ms % 1000)
    }
}

async fn execute_cell(
    provisioner: &dyn JavaScriptKernelProvisioner,
    report_startup_progress: BootstrapProgressHandler,
    code: &str,
    execute: KernelExecuteOptions<'_>,
) -> anyhow::Result<(ExecuteResult, bool)> {
    let manager = provisioner
        .ensure(Some(report_startup_progress), execute.signal.clone())
        .await?;
    let result = manager.execute(code, execute).await?;
    // The cell outlived its limit and ignored the interrupt: restart the kernel.
    let kernel_restarted =
        result.timed_out_after_ms.is_some() && result.status == ExecuteStatus::Aborted;
    if kernel_restarted {
        provisioner.kill().await;
    }
    Ok((result, kernel_restarted))
}

pub struct JavaScriptToolOptions {
    /// Shared provisioner owning the kernel lifecycle.
    pub provisioner: Arc<dyn JavaScriptKernelProvisioner>,
    pub on_late_sent_agent_message: Option<LateSentAgentMessageHandler>,
}

#[must_use]
pub fn javascript_tool_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "required": ["code"],
        "properties": {
            "code": {
                "type": "string",
                "description": "JavaScript or TypeScript code to execute in the persistent Bun REPL. Use the target project's own environment for project builds, tests, scripts, CLIs, and dependency checks instead of direct kernel imports."
            },
            "timeout": {
                "type": "integer",
                "description": format!(
                    "Seconds before this cell is interrupted (default {} unless the user configured otherwise, max {JAVASCRIPT_REPL_TIMEOUT_MAX_S}).",
                    DEFAULT_JAVASCRIPT_CELL_TIMEOUT_MS / 1000
                )
            }
        }
    })
}

/// The largest per-call `timeout` the model may pass, in seconds.
pub const JAVASCRIPT_REPL_TIMEOUT_MAX_S: u64 = 180;

/// The model's `timeout` argument as a cell limit in milliseconds, clamped to
/// 1..=[`JAVASCRIPT_REPL_TIMEOUT_MAX_S`] seconds.
fn timeout_arg_ms(params: &serde_json::Value) -> Option<u64> {
    let seconds = params.get("timeout")?.as_f64()?;
    Some((seconds as u64).clamp(1, JAVASCRIPT_REPL_TIMEOUT_MAX_S) * 1000)
}

#[must_use]
pub fn javascript_tool_description() -> &'static str {
    "Execute JavaScript or TypeScript code in a persistent Bun REPL. Top-level `await`, `return`, and static `import` statements are supported. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (values that cannot be serialized are dropped and reported). Run shell commands with `bash('cmd')` / `await bash('cmd')`, `sh('cmd')`, or Bun Shell `$`. Project builds, tests, scripts, CLIs, and dependency checks should run through the target project's own environment."
}

/// Execute one JavaScript cell and format the tool result payload.
///
/// # Errors
///
/// Returns an error if kernel startup or cell IPC fails.
#[tracing::instrument(
    level = "debug",
    name = "tool_javascript_execute",
    skip(options, on_update, on_late_sent_agent_message)
    fields(code),
)]
pub async fn execute_javascript(
    options: &JavaScriptToolOptions,
    code: &str,
    timeout_ms: Option<u64>,
    signal: Option<AbortSignal>,
    on_update: Option<OnUpdate>,
    on_late_sent_agent_message: Option<crate::kernel::shared::LateSentAgentMessageCallback>,
) -> anyhow::Result<ToolExecutionResult> {
    let report_startup_progress: BootstrapProgressHandler = {
        let on_update = on_update.clone();
        Arc::new(move |message: &str| {
            if let Some(on_update) = &on_update {
                on_update(ToolUpdate {
                    content: vec![ToolContentBlock::text(message.to_string())],
                    details: Some(json!({ "status": "starting" })),
                });
            }
        })
    };

    let stream_update = |chunk: &str, _stream: &'static str| {
        if let Some(on_update) = &on_update {
            on_update(ToolUpdate {
                content: vec![ToolContentBlock::text(chunk.to_string())],
                details: Some(json!({ "status": "ok" })),
            });
        }
    };

    let result = execute_cell(
        options.provisioner.as_ref(),
        report_startup_progress,
        code,
        KernelExecuteOptions {
            signal,
            timeout_ms,
            on_stream: Some(&stream_update),
            on_late_sent_agent_message,
        },
    )
    .await;

    let (r, kernel_restarted) = result.map_err(|err| anyhow::anyhow!("{err:#}"))?;

    let mut text = format_execute_text(&r, r.background_output.as_deref(), kernel_restarted);
    if kernel_restarted {
        text = if text.is_empty() {
            kernel_restart_notice().to_string()
        } else {
            format!("{}\n\n{}", kernel_restart_notice(), text)
        };
    }
    if r.ended_turn {
        let separator = if text.is_empty() { "" } else { "\n" };
        let _ = write!(text, "{separator}turn ended");
    }

    let image_blocks = image_blocks_from_attachments(&r.attachments);
    let mut content = vec![ToolContentBlock::text(text)];
    content.extend(image_blocks);

    let status = match r.status {
        ExecuteStatus::Ok => "ok",
        ExecuteStatus::Aborted if r.timed_out_after_ms.is_none() => "aborted",
        ExecuteStatus::Error | ExecuteStatus::Aborted => "error",
    };
    let mut details = json!({
        "status": status,
        "kernelRestarted": kernel_restarted,
    });
    if let Some(duration) = r.duration_ms {
        details["durationMs"] = json!(duration);
    }
    if !r.stdout.is_empty() {
        details["stdout"] = json!(r.stdout);
    }
    if !r.stderr.is_empty() {
        details["stderr"] = json!(r.stderr);
    }
    if let Some(result_text) = &r.result {
        details["result"] = json!(result_text);
    }
    if let Some(bash) = &r.bash_commands {
        details["bashCommands"] = json!({
            "first": bash.first,
            "count": bash.count,
            "lines": bash.lines,
        });
    }
    if !r.transcript_reads.is_empty() {
        details["transcriptReads"] = json!(r.transcript_reads);
    }
    if let Some(background) = &r.background_output {
        details["backgroundOutput"] = json!(background);
    }
    if let Some(error) = &r.error {
        details["error"] = json!({
            "ename": error.ename,
            "evalue": error.evalue,
            "traceback": error.traceback,
        });
        details["errorEname"] = json!(error.ename);
    }
    if !r.diffs.is_empty() {
        details["diffs"] = json!(r
            .diffs
            .iter()
            .map(|diff| {
                let start_line = diff
                    .start_line
                    .and_then(|line| usize::try_from(line).ok())
                    .unwrap_or(1);
                json!({
                    "path": diff.path,
                    "diff": generate_diff_string(&diff.old_str, &diff.new_str, 4, start_line),
                })
            })
            .collect::<Vec<_>>());
    }
    if !r.sent_agent_messages.is_empty() {
        details["sentAgentMessages"] = json!(r
            .sent_agent_messages
            .iter()
            .map(sent_agent_message_json)
            .collect::<Vec<_>>());
    }

    Ok(ToolExecutionResult {
        content,
        details: Some(details),
        is_error: r.status == ExecuteStatus::Error || r.status == ExecuteStatus::Aborted,
        terminate: r.ended_turn.then_some(true),
    })
}

/// The `javascript` tool definition: exact name, label (`Bun`), schema, and description.
#[must_use]
pub fn create_javascript_tool_definition(
    _cwd: &str,
    options: JavaScriptToolOptions,
) -> ToolDefinition {
    let options = Arc::new(options);
    let execute: crate::tools::tool_definition::ExecuteFn = {
        let options = options;
        Arc::new(move |tool_call_id, params, signal, on_update| {
            let options = options.clone();
            let on_late_sent_agent_message =
                options.on_late_sent_agent_message.as_ref().map(|handler| {
                    let handler = std::sync::Arc::clone(handler);
                    let tool_call_id = tool_call_id.to_string();
                    std::sync::Arc::new(move |message| handler(&tool_call_id, message))
                        as crate::kernel::shared::LateSentAgentMessageCallback
                });
            Box::pin(async move {
                let code = params
                    .get("code")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("javascript tool requires a code string"))?
                    .to_string();
                execute_javascript(
                    &options,
                    &code,
                    timeout_arg_ms(&params),
                    signal,
                    on_update,
                    on_late_sent_agent_message,
                )
                .await
            })
        })
    };
    ToolDefinition {
        name: pa_types::ai::JAVASCRIPT_TOOL_NAME.to_string(),
        label: "Bun".to_string(),
        description: javascript_tool_description().to_string(),
        prompt_snippet:
            "javascript - persistent Bun REPL for JavaScript/TypeScript, state, and bash() orchestration"
                .to_string(),
        execution_mode: Some(ExecutionMode::Sequential),
        parameters: javascript_tool_schema(),
        prepare_arguments: None,
        execute,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_arg_is_clamped_to_the_allowed_range() {
        assert_eq!(timeout_arg_ms(&json!({ "code": "" })), None);
        assert_eq!(timeout_arg_ms(&json!({ "timeout": 5 })), Some(5_000));
        assert_eq!(timeout_arg_ms(&json!({ "timeout": 0 })), Some(1_000));
        assert_eq!(
            timeout_arg_ms(&json!({ "timeout": 3600 })),
            Some(JAVASCRIPT_REPL_TIMEOUT_MAX_S * 1000)
        );
    }

    #[test]
    fn humanize_ms_pads_the_millisecond_remainder() {
        assert_eq!(humanize_ms(500), "500ms");
        assert_eq!(humanize_ms(2000), "2s");
        assert_eq!(humanize_ms(60_000), "60s");
        assert_eq!(humanize_ms(1500), "1.500s");
        assert_eq!(humanize_ms(60_005), "60.005s");
    }

    #[test]
    fn sent_agent_message_json_matches_ts_wire_shape() {
        let sent = crate::kernel::shared::KernelSentAgentMessage {
            id: "agentmsg_1".to_string(),
            message: "Ping.\nThen report back.".to_string(),
            delivery_status: crate::kernel::shared::SentDeliveryStatus::Delivered,
            receiver_role: Some(crate::kernel::shared::ReceiverRole::Parent),
            target: crate::kernel::shared::SentAgentMessageTarget {
                active_session_id: "worker-active".to_string(),
                session_id: "worker-session".to_string(),
                session_name: Some("Worker".to_string()),
            },
        };
        assert_eq!(
            sent_agent_message_json(&sent),
            json!({
                "id": "agentmsg_1",
                "message": "Ping.\nThen report back.",
                "deliveryStatus": "delivered",
                "receiverRole": "parent",
                "target": {
                    "activeSessionId": "worker-active",
                    "sessionId": "worker-session",
                    "sessionName": "Worker",
                },
            })
        );
        let queued = crate::kernel::shared::KernelSentAgentMessage {
            id: "agentmsg_2".to_string(),
            message: "Ping.".to_string(),
            delivery_status: crate::kernel::shared::SentDeliveryStatus::Queued,
            receiver_role: None,
            target: crate::kernel::shared::SentAgentMessageTarget {
                active_session_id: "a1".to_string(),
                session_id: "s1".to_string(),
                session_name: None,
            },
        };
        assert_eq!(
            sent_agent_message_json(&queued),
            json!({
                "id": "agentmsg_2",
                "message": "Ping.",
                "deliveryStatus": "queued",
                "target": { "activeSessionId": "a1", "sessionId": "s1" },
            })
        );
    }
}
