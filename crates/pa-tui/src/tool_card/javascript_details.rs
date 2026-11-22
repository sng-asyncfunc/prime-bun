//! Parsing of `javascript` execution `details` for the cell card: the
//! details record, the background-shell handle repr, literal shell
//! launches, the transcript reads, and the edit-confirmation and
//! agent-message-receipt suppressions.

use serde_json::Value;

/// Parsed `details` of one `javascript` execution result.
pub(crate) struct JavaScriptDetails {
    pub(crate) duration_ms: Option<f64>,
    pub(crate) status: Option<String>,
    pub(crate) error_ename: Option<String>,
    pub(crate) stdout: Option<String>,
    pub(crate) stderr: Option<String>,
    pub(crate) result: Option<String>,
    pub(crate) background_output: Option<String>,
    pub(crate) error: Option<JavaScriptError>,
    pub(crate) diffs: Vec<Value>,
    pub(crate) sent_agent_messages: Vec<Value>,
    pub(crate) bash_commands: Option<BashCommands>,
    pub(crate) transcript_reads: Vec<TranscriptRead>,
}

pub(crate) struct JavaScriptError {
    pub(crate) ename: String,
    pub(crate) evalue: String,
    pub(crate) traceback: Vec<String>,
}

/// The `bashCommands` details field: the first executed `bash()`/`sh()` command,
/// how many ran, and their summed non-blank line count.
pub(crate) struct BashCommands {
    pub(crate) first: String,
    pub(crate) count: usize,
    pub(crate) lines: usize,
}

fn read_bash_commands(value: &Value) -> Option<BashCommands> {
    let record = value.as_object()?;
    Some(BashCommands {
        first: record.get("first")?.as_str()?.to_string(),
        count: record
            .get("count")?
            .as_u64()
            .and_then(|count| usize::try_from(count).ok())?,
        lines: record
            .get("lines")?
            .as_u64()
            .and_then(|lines| usize::try_from(lines).ok())?,
    })
}

/// One `transcriptReads` record: what one `rlm.session.messages` read returned.
pub(crate) struct TranscriptRead {
    returned: u64,
    first: Option<u64>,
    total: u64,
    roles: Vec<String>,
    /// The family member whose transcript was read; `None` for the session's own.
    agent: Option<String>,
}

impl TranscriptRead {
    fn parse(value: &Value) -> Option<TranscriptRead> {
        Some(TranscriptRead {
            returned: value.get("returned")?.as_u64()?,
            first: value.get("first").and_then(Value::as_u64),
            total: value.get("total")?.as_u64()?,
            roles: value
                .get("roles")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            agent: value
                .get("agent")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
}

/// The card row for a cell's reads: `read 5 messages (role user) #12–#16 of 17`
/// for one read, `read 13 messages in 3 reads` for several. Reads of one family
/// member's transcript name it: `read 10 messages from worker-a #0–#9 of 40`.
pub(crate) fn transcript_reads_summary(reads: &[TranscriptRead]) -> Option<String> {
    let plural =
        |count: u64, noun: &str| format!("{count} {noun}{}", if count == 1 { "" } else { "s" });
    let agent = reads.first()?.agent.as_deref();
    let from = agent
        .filter(|_| reads.iter().all(|read| read.agent.as_deref() == agent))
        .map(|agent| format!(" from {agent}"))
        .unwrap_or_default();
    match reads {
        [read] => {
            let roles = (read.roles != ["*"]).then(|| format!(" (role {})", read.roles.join("|")));
            let range = read.first.filter(|_| read.returned > 0).map(|first| {
                let last = first + read.returned - 1;
                if first == last {
                    format!(" #{first}")
                } else {
                    format!(" #{first}\u{2013}#{last}")
                }
            });
            Some(format!(
                "read {}{from}{}{} of {}",
                plural(read.returned, "message"),
                roles.unwrap_or_default(),
                range.unwrap_or_default(),
                read.total
            ))
        }
        _ => Some(format!(
            "read {}{from} in {}",
            plural(reads.iter().map(|read| read.returned).sum(), "message"),
            plural(reads.len() as u64, "read")
        )),
    }
}

pub(crate) fn read_error_details(value: &Value) -> Option<JavaScriptError> {
    let record = value.as_object()?;
    let ename = record.get("ename")?.as_str()?.to_string();
    Some(JavaScriptError {
        ename,
        evalue: record
            .get("evalue")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        traceback: record
            .get("traceback")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

impl JavaScriptDetails {
    pub(crate) fn parse(details: &Value) -> JavaScriptDetails {
        let empty = JavaScriptDetails {
            duration_ms: None,
            status: None,
            error_ename: None,
            stdout: None,
            stderr: None,
            result: None,
            background_output: None,
            error: None,
            diffs: Vec::new(),
            sent_agent_messages: Vec::new(),
            bash_commands: None,
            transcript_reads: Vec::new(),
        };
        let Some(record) = details.as_object() else {
            return empty;
        };
        let error = record.get("error").and_then(read_error_details);
        JavaScriptDetails {
            duration_ms: record.get("durationMs").and_then(Value::as_f64),
            status: record
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
            error_ename: error.as_ref().map(|e| e.ename.clone()).or_else(|| {
                record
                    .get("errorEname")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
            stdout: record
                .get("stdout")
                .and_then(Value::as_str)
                .map(str::to_string),
            stderr: record
                .get("stderr")
                .and_then(Value::as_str)
                .map(str::to_string),
            result: record
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string),
            background_output: record
                .get("backgroundOutput")
                .and_then(Value::as_str)
                .map(str::to_string),
            error,
            diffs: record
                .get("diffs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            sent_agent_messages: record
                .get("sentAgentMessages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            bash_commands: record.get("bashCommands").and_then(read_bash_commands),
            transcript_reads: record
                .get("transcriptReads")
                .and_then(Value::as_array)
                .map(|reads| reads.iter().filter_map(TranscriptRead::parse).collect())
                .unwrap_or_default(),
        }
    }
}

/// `formatDuration`: whole `ms` below a second, tenths above.
pub(crate) fn format_duration(duration_ms: f64) -> String {
    if duration_ms < 1000.0 {
        format!("{}ms", duration_ms.round())
    } else {
        format!("{:.1}s", duration_ms / 1000.0)
    }
}

/// Strip one layer of repr quotes so an `execute_result` string compares
/// cleanly (TS `stripReprQuotes`).
pub(crate) fn strip_repr_quotes(text: &str) -> &str {
    let trimmed = text.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('\'') && trimmed.ends_with('\''))
            || (trimmed.starts_with('"') && trimmed.ends_with('"')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

/// True when `text` is the edit skill's "Edited <path>" confirmation for one
/// of the cell's diffs (TS `isEditConfirmation`).
pub(crate) fn is_edit_confirmation(text: Option<&str>, diffs: &[Value]) -> bool {
    let Some(text) = text else {
        return false;
    };
    let stripped = strip_repr_quotes(text);
    diffs.iter().any(|diff| {
        diff.get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| stripped == format!("Edited {path}"))
    })
}

/// One parsed sent agent message (TS `SentAgentMessageDisplay`): the
/// body text, `delivered` vs `queued`, and the counterpart's display
/// name (name, then active session id, session id, then `unknown`; the
/// viewer-relative arrow is the operator's 2026-09-25 directive).
pub(crate) struct SentAgentMessage {
    pub(crate) message: String,
    pub(crate) delivered: bool,
    pub(crate) counterpart: String,
}

/// Parse one `sentAgentMessages` entry; `None` on a malformed record
/// (a missing message or target leaves nothing renderable).
pub(crate) fn parse_sent_agent_message(value: &Value) -> Option<SentAgentMessage> {
    let message = value.get("message")?.as_str()?.to_string();
    let delivered = value.get("deliveryStatus").and_then(Value::as_str) == Some("delivered");
    let target = value.get("target").unwrap_or(&Value::Null);
    let counterpart = ["sessionName", "activeSessionId", "sessionId"]
        .iter()
        .find_map(|key| {
            target
                .get(*key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|name| !name.trim().is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());
    Some(SentAgentMessage {
        message,
        delivered,
        counterpart,
    })
}

/// True when `text` is the `agentMessage.send` receipt object for one of
/// the sent messages already summarized above the output (handles `Bun.inspect`
/// object formatting `{ id: "..." }` as well as JSON and legacy dict reprs).
pub(crate) fn is_agent_message_receipt(text: Option<&str>, messages: &[Value]) -> bool {
    let Some(text) = text else {
        return false;
    };
    if messages.is_empty() {
        return false;
    }
    let stripped = strip_repr_quotes(text);
    messages.iter().any(|message| {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return false;
        };
        stripped.starts_with(&format!("{{'id': '{id}"))
            || stripped.starts_with(&format!("{{\"id\": \"{id}"))
            || stripped.starts_with(&format!("{{ id: \"{id}\""))
            || stripped.starts_with(&format!("{{ id: '{id}'"))
            || (stripped.starts_with('{')
                && stripped.ends_with('}')
                && (stripped.contains(&format!("id: \"{id}\""))
                    || stripped.contains(&format!("id: '{id}'"))
                    || stripped.contains(&format!("\"id\": \"{id}\""))))
    })
}

/// A background shell launched by the cell (the result is a
/// `<BashHandle pid=... running|exit_code=N command=...>` repr).
pub(crate) struct BackgroundShell {
    pub(crate) exit_code: Option<i64>,
}

fn is_js_ident(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c == '_' || c == '$' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c == '$' || c.is_ascii_alphanumeric())
}

/// The cell is a single `bash(...)`, `sh(...)`, or `` $`...` `` launch
/// (optionally assigned with `const`/`let`/`var` or bare assignment, optionally
/// `await`ed, optionally preceded by `import` lines).
pub(crate) fn literal_shell_command(code: &str) -> Option<String> {
    let launch: Vec<&str> = code
        .trim()
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.starts_with("import ")
        })
        .collect();
    let source = launch.first()?.trim().trim_end_matches(';').trim_end();

    // Strip optional `(const|let|var) <ident> =` or `<ident> =`.
    let expr = if let Some(eq_idx) = source.find('=') {
        let lhs = source[..eq_idx].trim();
        let rhs = source[eq_idx + 1..].trim_start();
        let lhs_var = lhs
            .strip_prefix("const ")
            .or_else(|| lhs.strip_prefix("let "))
            .or_else(|| lhs.strip_prefix("var "))
            .map_or(lhs, str::trim_start);
        if is_js_ident(lhs_var) && !rhs.starts_with('=') {
            rhs
        } else {
            source
        }
    } else {
        source
    };

    // Strip optional `await `.
    let expr = expr
        .strip_prefix("await")
        .filter(|rest| rest.chars().next().is_some_and(char::is_whitespace))
        .map_or(expr, str::trim_start);

    // Bun shell template literal: $`...`
    if let Some(rest) = expr.strip_prefix("$`") {
        let body = rest.strip_suffix('`')?;
        return Some(body.to_string());
    }

    let open = expr.find('(')?;
    if !expr.ends_with(')') {
        return None;
    }
    let callee = expr[..open].trim_end();
    if !matches!(callee, "bash" | "sh" | "rlm.bash" | "rlm.sh") {
        return None;
    }
    read_js_string(expr[open + 1..expr.len() - 1].trim())
}

/// A single-quoted, double-quoted, or backtick JS string literal body.
pub(crate) fn read_js_string(text: &str) -> Option<String> {
    let mut chars = text.chars();
    let quote = chars.next()?;
    if quote != '\'' && quote != '"' && quote != '`' {
        return None;
    }
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            out.push(chars.next()?);
            continue;
        }
        if c == quote {
            return Some(out);
        }
        out.push(c);
    }
    None
}

pub(crate) fn read_background_shell(code: &str, details: &Value) -> Option<BackgroundShell> {
    let result = details.get("result")?.as_str()?;
    let trimmed = result.trim();
    let rest = trimmed.strip_prefix("<BashHandle pid=")?;
    let (pid, rest) = rest.split_once(' ')?;
    if pid.parse::<u64>().ok()? == 0 {
        return None;
    }
    let (state, rest) = rest.split_once(' ')?;
    let exit_code = if state == "running" {
        None
    } else {
        let code = state.strip_prefix("exit_code=")?.parse::<i64>().ok()?;
        Some(code)
    };
    if !rest.starts_with("command=") || !rest.ends_with('>') {
        return None;
    }
    let command = read_js_string(&rest["command=".len()..rest.len() - 1])?;
    if literal_shell_command(code).as_deref() != Some(command.as_str()) {
        return None;
    }
    Some(BackgroundShell { exit_code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sent_agent_message_shapes() {
        let delivered = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_1",
            "message": "Ping.",
            "deliveryStatus": "delivered",
            "receiverRole": "parent",
            "target": { "activeSessionId": "a1", "sessionId": "s1", "sessionName": "Worker" },
        }))
        .expect("delivered receipt");
        assert!(delivered.delivered);
        assert_eq!(delivered.message, "Ping.");
        assert_eq!(delivered.counterpart, "Worker");
        let by_active = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_2",
            "message": "Ping.",
            "deliveryStatus": "queued",
            "receiverRole": "sibling",
            "target": { "activeSessionId": "a1", "sessionId": "s1" },
        }))
        .expect("queued receipt");
        assert!(!by_active.delivered);
        assert_eq!(by_active.counterpart, "a1");
        let by_session = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_3",
            "message": "Ping.",
            "deliveryStatus": "queued",
            "target": { "sessionId": "s1" },
        }))
        .expect("bare target");
        assert_eq!(by_session.counterpart, "s1");
        let unknown = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_4",
            "message": "Ping.",
            "deliveryStatus": "queued",
        }))
        .expect("missing target falls back to unknown");
        assert_eq!(unknown.counterpart, "unknown");
        assert!(parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_5",
            "deliveryStatus": "delivered",
        }))
        .is_none());
    }

    #[test]
    fn recognizes_bun_inspect_agent_message_receipts() {
        let msgs = vec![serde_json::json!({ "id": "agentmsg_42" })];
        assert!(is_agent_message_receipt(
            Some("{ id: \"agentmsg_42\", deliveryStatus: \"delivered\" }"),
            &msgs
        ));
        assert!(is_agent_message_receipt(
            Some("{\n  id: \"agentmsg_42\",\n  deliveryStatus: \"queued\"\n}"),
            &msgs
        ));
        assert!(!is_agent_message_receipt(Some("plain output"), &msgs));
    }

    #[test]
    fn literal_shell_command_handles_js_forms() {
        assert_eq!(
            literal_shell_command("const h = bash('sleep 0.1');").as_deref(),
            Some("sleep 0.1")
        );
        assert_eq!(
            literal_shell_command("await sh(\"git status\")").as_deref(),
            Some("git status")
        );
        assert_eq!(
            literal_shell_command("const h = await $`sleep 1`;").as_deref(),
            Some("sleep 1")
        );
        assert_eq!(
            literal_shell_command("h = bash('sleep 0.1')").as_deref(),
            Some("sleep 0.1")
        );
    }
}
