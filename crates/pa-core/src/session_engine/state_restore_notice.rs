//! The resumed-session kernel-state notice (`javascript_state_restored`): a resumed session
//! spawns a fresh Bun kernel and the namespace snapshot revives the bindings; the
//! provisioner's `on_restore` seam reports the outcome so the model is told BEFORE
//! the first turn. The fresh kernel owns nothing, so this notice never prunes.

use pa_types::session::CustomMessage;

use crate::kernel::state_snapshot::RestoreResult;

pub const JAVASCRIPT_STATE_RESTORED_CUSTOM_TYPE: &str = "javascript_state_restored";

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The notice text: the `[javascript-state-restored]` header, the
/// revived-or-fresh line, and the failed-names disclosure (Bun snapshots
/// also restore `process.cwd()` and `process.env` deltas).
#[must_use]
pub fn notice_content(result: &RestoreResult) -> String {
    let mut lines = vec!["[javascript-state-restored]".to_string(), String::new()];
    if result.restored.is_empty() {
        lines.push(
            "Your previous JavaScript kernel state could not be revived; the Bun kernel is starting fresh, so re-create any variables, imports, or loaded data you need.".to_string(),
        );
    } else {
        lines.push(format!(
            "Your JavaScript kernel state was revived from your previous session. These names are available again: {}.",
            result.restored.join(", ")
        ));
    }
    if !result.failed.is_empty() {
        lines.push(format!(
            "These could not be restored and must be recreated if needed: {}.",
            result
                .failed
                .iter()
                .map(|skip| skip.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    lines.join("\n")
}

/// The next-turn notice row: display true, `details.restored` flagging whether anything
/// revived; the row rides the next admitted turn ahead of its prompt.
#[must_use]
pub fn notice_message(result: &RestoreResult) -> CustomMessage {
    CustomMessage {
        custom_type: JAVASCRIPT_STATE_RESTORED_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(notice_content(result)),
        display: true,
        details: Some(serde_json::json!({
            "restored": !result.restored.is_empty(),
        })),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::state_snapshot::SnapshotSkip;

    fn restore(restored: Vec<&str>, failed: Vec<(&str, &str)>) -> RestoreResult {
        RestoreResult {
            restored: restored.into_iter().map(str::to_string).collect(),
            failed: failed
                .into_iter()
                .map(|(name, reason)| SnapshotSkip {
                    name: name.to_string(),
                    reason: reason.to_string(),
                })
                .collect(),
            path: std::path::PathBuf::from("/tmp/art/kernel-state.bin"),
        }
    }

    #[test]
    fn revived_notice_lists_names() {
        let message = notice_message(&restore(vec!["data", "helper"], vec![]));
        assert_eq!(message.custom_type, "javascript_state_restored");
        assert!(message.display);
        assert_eq!(
            message.details,
            Some(serde_json::json!({ "restored": true }))
        );
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[javascript-state-restored]\n\nYour JavaScript kernel state was revived from your previous session. These names are available again: data, helper."
        );
    }

    #[test]
    fn empty_restore_notifies_fresh_kernel() {
        let message = notice_message(&restore(vec![], vec![]));
        assert_eq!(
            message.details,
            Some(serde_json::json!({ "restored": false }))
        );
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[javascript-state-restored]\n\nYour previous JavaScript kernel state could not be revived; the Bun kernel is starting fresh, so re-create any variables, imports, or loaded data you need."
        );
    }

    #[test]
    fn failed_names_get_the_recreate_line() {
        let message = notice_message(&restore(vec!["data"], vec![("sock", "unserializable")]));
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert!(
            content.contains("These could not be restored and must be recreated if needed: sock.")
        );
    }
}
