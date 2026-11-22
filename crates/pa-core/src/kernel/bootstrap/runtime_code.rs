//! The runtime bootstrap code injected into each Bun kernel right after start
//! or restore: configures completion-notice wiring and loads every prepared
//! JavaScript skill into `globalThis`.

use serde::Serialize;

use super::PreparedJavaScriptSkill;

/// Line the runtime bootstrap prints when one or more pre-loaded JavaScript
/// skills failed to load. The host scans the bootstrap cell's stdout for this
/// marker.
pub const JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER: &str =
    "__PRIME_AGENT_JAVASCRIPT_SKILL_IMPORT_ERRORS__";

/// Failed skill loads reported by a bootstrap cell: `(global name, load error)`
/// pairs in load order.
pub type UnavailableJavaScriptSkills = Vec<(String, String)>;

/// Extract the unavailable-skill report a bootstrap cell printed, or `None`
/// when it printed none: the marker must be followed by a JSON object with at
/// least one non-empty string value.
#[must_use]
pub fn parse_unavailable_javascript_skills(stdout: &str) -> Option<UnavailableJavaScriptSkills> {
    let at = stdout.find(JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER)?;
    let rest = &stdout[at + JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER.len()..];
    let raw = rest.trim_start().lines().next()?.trim();
    let parsed = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw).ok()?;
    let errors = parsed
        .into_iter()
        .filter_map(|(name, error)| {
            let error = error.as_str()?;
            (!error.is_empty()).then(|| (name, error.to_string()))
        })
        .collect::<UnavailableJavaScriptSkills>();
    (!errors.is_empty()).then_some(errors)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapSkillPayload<'a> {
    name: &'a str,
    global_name: &'a str,
    entry_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<&'a str>,
}

/// The JavaScript bootstrap cell the session injects right after kernel
/// start/restore: disables color output in subprocesses, wires bounded `bash()`
/// completion notices when the host registered `bash.completed`, and loads all
/// prepared JavaScript skills via `globalThis.__primeLoadSkills`.
#[must_use]
pub fn build_rlm_bootstrap_code(
    skills: &[PreparedJavaScriptSkill],
    bash_notices_wired: bool,
) -> String {
    let mut lines = vec![String::from("process.env.NO_COLOR = \"1\";")];
    if bash_notices_wired {
        lines.push(String::from(
            "if (typeof globalThis.__primeSetCompletionNoticesWired === \"function\") { globalThis.__primeSetCompletionNoticesWired(true); }",
        ));
    }

    // Deduplicate by global_name in first-seen discovery order.
    let mut seen: Vec<&str> = Vec::new();
    let mut payload: Vec<BootstrapSkillPayload<'_>> = Vec::new();
    for skill in skills {
        let global = skill.global_name.as_str();
        if !seen.contains(&global) {
            seen.push(global);
            payload.push(BootstrapSkillPayload {
                name: &skill.name,
                global_name: global,
                entry_path: skill.entry_path.to_string_lossy().into_owned(),
                unavailable_reason: skill.unavailable_reason.as_deref(),
            });
        }
    }

    if !payload.is_empty() {
        let skills_json = serde_json::to_string(&payload).unwrap_or_else(|_| "[]".to_string());
        lines.push(format!(
            "const __primeSkillErrors = await globalThis.__primeLoadSkills({skills_json});"
        ));
        lines.push(format!(
            "if (__primeSkillErrors && typeof __primeSkillErrors === \"object\" && Object.keys(__primeSkillErrors).length > 0) {{ console.log(\"{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}\" + JSON.stringify(__primeSkillErrors)); }}"
        ));
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn bootstrap_code_without_skills_sets_no_color() {
        let code = build_rlm_bootstrap_code(&[], false);
        assert!(code.contains("process.env.NO_COLOR = \"1\";"));
        assert!(!code.contains("__primeLoadSkills"));
    }

    #[test]
    fn bootstrap_turns_the_bounded_bash_default_on_only_with_notices() {
        let daemonless = build_rlm_bootstrap_code(&[], false);
        let noticed = build_rlm_bootstrap_code(&[], true);
        assert!(
            noticed.contains("__primeSetCompletionNoticesWired(true)"),
            "the wired bootstrap must enable the bounded bash default: {noticed}"
        );
        assert!(
            !daemonless.contains("__primeSetCompletionNoticesWired"),
            "the daemonless bootstrap must not emit the toggle: {daemonless}"
        );
    }

    #[test]
    fn bootstrap_code_loads_skills() {
        let skills = vec![PreparedJavaScriptSkill {
            name: "edit".into(),
            global_name: "edit".into(),
            entry_path: PathBuf::from("/pkg/edit/src/index.ts"),
            package_path: PathBuf::from("/pkg/edit"),
            package_json_path: PathBuf::from("/pkg/edit/package.json"),
            unavailable_reason: None,
        }];
        let code = build_rlm_bootstrap_code(&skills, false);
        assert!(code.contains("__primeLoadSkills("));
        assert!(code.contains(r#""globalName":"edit""#));
        assert!(code.contains(JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER));
    }

    #[test]
    fn parse_unavailable_javascript_skills_table() {
        let cases: Vec<(String, Option<UnavailableJavaScriptSkills>)> = vec![
            (
                format!(
                    "{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{\"websearch\":\"Cannot find module 'websearch'\"}}\n"
                ),
                Some(vec![(
                    "websearch".into(),
                    "Cannot find module 'websearch'".into(),
                )]),
            ),
            (
                format!(
                    "noise\n{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{\"edit\":\"boom\"}}"
                ),
                Some(vec![("edit".into(), "boom".into())]),
            ),
            (
                format!(
                    "{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{\"edit\":\"boom\"}}\n{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{\"edit\":\"boom\"}}\n"
                ),
                Some(vec![("edit".into(), "boom".into())]),
            ),
            ("some unrelated kernel output".to_string(), None),
            (
                format!("{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}not json"),
                None,
            ),
            (
                format!("{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{}}"),
                None,
            ),
        ];
        for (stdout, expected) in cases {
            assert_eq!(
                parse_unavailable_javascript_skills(&stdout),
                expected,
                "{stdout}"
            );
        }
    }

    #[test]
    fn parse_unavailable_javascript_skills_drops_non_string_and_empty_values() {
        let stdout = format!(
            "{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{\"edit\":\"boom\",\"null_skill\":null,\"list_skill\":[1],\"empty_skill\":\"\",\"websearch\":\"Cannot find module 'websearch'\"}}"
        );
        assert_eq!(
            parse_unavailable_javascript_skills(&stdout),
            Some(vec![
                ("edit".into(), "boom".into()),
                ("websearch".into(), "Cannot find module 'websearch'".into()),
            ])
        );
        let stdout =
            format!("{JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}{{\"empty_skill\":\"\"}}");
        assert_eq!(parse_unavailable_javascript_skills(&stdout), None);
    }
}
