//! JavaScript-side preview analysis: port of `previewJavaScriptCode` from
//! `packages/coding-agent/src/core/tools/code-preview.ts`.

use super::bash::re_once;
use super::bash::{
    descriptor, is_comment_line, js_trim, js_trim_end, simplify_bash_command_line, CodePreview,
    CodePreviewLanguage, S, W,
};

fn is_javascript_import(line: &str) -> bool {
    re_once!(format!(r"^{S}*import{S}+")).is_match(line)
}

fn is_javascript_definition(line: &str) -> bool {
    re_once!(format!(
        r"^{S}*(?:export{S}+)?(?:async{S}+)?(?:function|class){S}+|^{S}*(?:const|let|var){S}+{W}+{S}*={S}*(?:async{S}*)?\("
    ))
    .is_match(line)
}

fn is_javascript_control(line: &str) -> bool {
    re_once!(format!(
        r"^{S}*(?:if|else|for|while|switch|try|catch|finally)\b"
    ))
    .is_match(line)
}

fn is_javascript_call(line: &str) -> bool {
    re_once!(format!(
        r"^{S}*(?:await{S}+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*{S}*\("
    ))
    .is_match(line)
}

fn is_javascript_low_signal_call(line: &str) -> bool {
    re_once!(format!(
        r"^{S}*(?:await{S}+)?(?:process\.chdir|console\.(?:log|error|warn)|JSON\.(?:parse|stringify)|String|Number|Boolean|Array|Object){S}*\("
    ))
    .is_match(line)
}

fn is_javascript_assignment_call(line: &str) -> bool {
    re_once!(format!(
        r"^{S}*(?:const|let|var){S}+[A-Za-z_$][A-Za-z0-9_$]*(?:{S}*:{S}*[^=]+)?{S}*={S}*(?:await{S}+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*{S}*\("
    ))
    .is_match(line)
}

fn is_javascript_effect_call(line: &str) -> bool {
    re_once!(format!(
        r"^{S}*(?:await{S}+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\.(?:write|writeFile|mkdir|rm|unlink|rename|append|push|set|add|delete|close|commit|execute|run){S}*\("
    ))
    .is_match(line)
}

fn shell_command_from_javascript(line: &str) -> Option<String> {
    if let Some(template) = re_once!(format!(r"^{S}*(?:await{S}+)?\$`([\s\S]*)`{S}*;?$"))
        .captures(line)
        .and_then(|c| c.get(1))
        .map(|g| g.as_str())
    {
        if !template.is_empty() {
            return Some(simplify_bash_command_line(template));
        }
    }
    if let Some(call) = re_once!(format!(
        r#"^{S}*(?:await{S}+)?(?:sh|bash)\({S}*["'`]([^"'`]+)["'`]"#
    ))
    .captures(line)
    .and_then(|c| c.get(1))
    .map(|g| g.as_str())
    {
        if !call.is_empty() {
            return Some(simplify_bash_command_line(call));
        }
    }
    None
}

fn javascript_line_score(line: &str, index: usize) -> i64 {
    let trimmed = js_trim(line);
    if trimmed.is_empty() || is_comment_line(trimmed) || is_javascript_import(trimmed) {
        return -1;
    }
    let idx = i64::try_from(index).unwrap_or(i64::MAX / 2);
    if shell_command_from_javascript(trimmed).is_some() {
        return 100 + idx;
    }
    if is_javascript_effect_call(trimmed) {
        return 90 + idx;
    }
    if is_javascript_control(trimmed) {
        return 65 + idx;
    }
    if is_javascript_definition(trimmed) {
        return 50 + idx;
    }
    if is_javascript_assignment_call(trimmed) {
        return 70 + idx;
    }
    if is_javascript_call(trimmed) && !is_javascript_low_signal_call(trimmed) {
        return 75 + idx;
    }
    if is_javascript_low_signal_call(trimmed) {
        return 20 + idx;
    }
    35 + idx
}

fn simplify_javascript_line(line: &str) -> String {
    let trimmed = js_trim(line);
    if let Some(shell) = shell_command_from_javascript(trimmed) {
        return shell;
    }
    if let Some(inner) = re_once!(r"^console\.(?:log|error|warn)\((.*)\);?$")
        .captures(trimmed)
        .and_then(|c| c.get(1))
        .map(|g| js_trim(g.as_str()))
        .filter(|inner| !inner.is_empty())
    {
        return inner.to_string();
    }
    trimmed.to_string()
}

fn strip_javascript_cwd_prefix(line: &str) -> String {
    let stripped = re_once!(format!(
        r"^{S}*process\.chdir\((?:[^()]|\([^()]*\))*\){S}*;{S}*"
    ))
    .replace(line, "");
    if js_trim(&stripped).is_empty() {
        line.to_string()
    } else {
        stripped
    }
}

/// Pick the highest-signal line of a JavaScript cell as its preview.
#[must_use]
pub fn preview_javascript_code(code: &str) -> CodePreview {
    let trimmed = js_trim_end(code);
    let mut best: Option<(CodePreviewLanguage, String, i64)> = None;
    for (index, raw_line) in trimmed.split('\n').enumerate() {
        let line = strip_javascript_cwd_prefix(raw_line);
        let score = javascript_line_score(&line, index);
        if score < 0 {
            continue;
        }
        let language = if shell_command_from_javascript(&line).is_some() {
            CodePreviewLanguage::Bash
        } else {
            CodePreviewLanguage::JavaScript
        };
        let text = simplify_javascript_line(&line);
        if best.as_ref().is_none_or(|(_, _, s)| score > *s) {
            best = Some((language, text, score));
        }
    }
    match best {
        Some((language, text, _)) => CodePreview {
            language,
            text: descriptor(&text),
        },
        None => CodePreview::javascript(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_bun_shell_templates_as_bash() {
        let code =
            "const cwd = \"packages/coding-agent\";\nawait `${cwd}`;\nawait $`npm run check`;";
        assert_eq!(
            preview_javascript_code(code),
            CodePreview {
                language: CodePreviewLanguage::Bash,
                text: "npm check".to_string(),
            }
        );
    }

    #[test]
    fn previews_sh_and_bash_calls_as_bash() {
        assert_eq!(
            preview_javascript_code("await sh(\"git status --short\")"),
            CodePreview {
                language: CodePreviewLanguage::Bash,
                text: "git status --short".to_string(),
            }
        );
        assert_eq!(
            preview_javascript_code("await bash(\"git status --porcelain\")"),
            CodePreview {
                language: CodePreviewLanguage::Bash,
                text: "git status --porcelain".to_string(),
            }
        );
    }

    #[test]
    fn prefers_effect_calls_over_setup_assignments() {
        let code = "const path = \"packages/coding-agent/src/core/tools/javascript.ts\";\nconst text = await Bun.file(path).text();\nawait Bun.write(path, text.replace(\"old\", \"new\"));";
        assert_eq!(
            preview_javascript_code(code),
            CodePreview::javascript("await Bun.write(path, text.replace(\"old\", \"new\"));")
        );
    }

    #[test]
    fn prefers_repository_inspection_over_cwd_setup() {
        let code = "process.chdir('/Users/sheing/temp/sharenow');\nconst readme = await fs.promises.readFile('README.md','utf8');\nconsole.log(readme);";
        assert_eq!(
            preview_javascript_code(code),
            CodePreview::javascript(
                "const readme = await fs.promises.readFile('README.md','utf8');"
            )
        );
    }

    #[test]
    fn skips_inline_cwd_setup_prefix() {
        assert_eq!(
            preview_javascript_code("process.chdir(process.cwd()); fs.readFileSync('README.md');"),
            CodePreview::javascript("fs.readFileSync('README.md');")
        );
    }

    #[test]
    fn prefers_executable_calls_over_helper_definitions() {
        let code = "function helper() {\n  return 1;\n}\nawait runCheck();";
        assert_eq!(
            preview_javascript_code(code),
            CodePreview::javascript("await runCheck();")
        );
    }

    #[test]
    fn redacts_sensitive_javascript_preview_values() {
        assert_eq!(
            preview_javascript_code("const password = \"supersecretvalue\";"),
            CodePreview::javascript("const password=<redacted>;")
        );
        assert_eq!(
            preview_javascript_code(
                "const client = createClient({ apiKey: \"sk-testsecretvalue\" });"
            ),
            CodePreview::javascript("const client = createClient({ apiKey=<redacted> });")
        );
    }
}
