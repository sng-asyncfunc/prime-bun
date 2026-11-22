//! The JavaScript-skills-unavailable notice (`javascript_skills_unavailable`): a broken
//! pre-loaded skill stays behind a placeholder that throws on first call, so the bootstrap
//! reports failed loads through the marker line and the provisioner's `on_unavailable_skills`
//! seam hands them here — the model is told BEFORE it spends turns reading the skill's SKILL.md.

use pa_types::session::CustomMessage;

use crate::kernel::bootstrap::UnavailableJavaScriptSkills;

pub const JAVASCRIPT_SKILLS_UNAVAILABLE_CUSTOM_TYPE: &str = "javascript_skills_unavailable";

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// The notice text: the `[javascript-skills-unavailable]` header, the
/// per-skill load errors, and the fix hint.
#[must_use]
pub fn notice_content(errors: &UnavailableJavaScriptSkills) -> String {
    let mut lines = vec!["[javascript-skills-unavailable]".to_string(), String::new()];
    lines.push(
        "These installed JavaScript skill modules failed to load into the Bun kernel, so calling them throws an error:".to_string(),
    );
    for (name, error) in errors {
        lines.push(format!("- {name}: {error}"));
    }
    lines.push(String::new());
    lines.push(
        "Fix the load error first (for example check the skill's `package.json` dependencies or entry module and restart the Bun kernel), or use another approach.".to_string(),
    );
    lines.join("\n")
}

/// The next-turn notice row: display true, `details.skills` naming the failed skills;
/// the row rides the next admitted turn ahead of its prompt.
#[must_use]
pub fn notice_message(errors: &UnavailableJavaScriptSkills) -> CustomMessage {
    CustomMessage {
        custom_type: JAVASCRIPT_SKILLS_UNAVAILABLE_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(notice_content(errors)),
        display: true,
        details: Some(serde_json::json!({
            "skills": errors.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(),
        })),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn errors() -> UnavailableJavaScriptSkills {
        vec![
            (
                "websearch".to_string(),
                "Cannot find module 'websearch'".to_string(),
            ),
            ("edit".to_string(), "boom".to_string()),
        ]
    }

    #[test]
    fn notice_names_each_failed_skill_and_its_error() {
        let message = notice_message(&errors());
        assert_eq!(message.custom_type, "javascript_skills_unavailable");
        assert!(message.display);
        assert_eq!(
            message.details,
            Some(serde_json::json!({ "skills": ["websearch", "edit"] }))
        );
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[javascript-skills-unavailable]\n\nThese installed JavaScript skill modules failed to load into the Bun kernel, so calling them throws an error:\n- websearch: Cannot find module 'websearch'\n- edit: boom\n\nFix the load error first (for example check the skill's `package.json` dependencies or entry module and restart the Bun kernel), or use another approach."
        );
    }
}
