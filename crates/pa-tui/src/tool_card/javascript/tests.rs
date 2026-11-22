use super::*;
use crate::theme::{ColorMode, Theme};
use serde_json::json;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn cell_card(code: &str, details: Value, is_error: bool, partial: bool) -> ToolCallCard {
    ToolCallCard {
        id: "toolu_1".into(),
        name: "javascript".into(),
        args: json!({ "code": code }),
        started: true,
        result: Some(super::super::ToolResultView {
            content: vec![],
            details,
            is_error,
        }),
        result_partial: partial,
        ..Default::default()
    }
}

/// Render a card whose own detail matches the conversation level, with images shown.
fn render_card(card: &ToolCallCard, detail: Detail) -> Vec<Line> {
    render(card, 0, detail, detail, &theme(), 100, true)
}

fn text_of(line: &Line) -> String {
    line.iter().map(|s| s.content.as_str()).collect()
}

#[test]
fn done_cell_summary_line_uses_js_label_and_inline_short_intent() {
    let card = cell_card(
        "path.basename(\"/tmp/report.txt\")",
        json!({
            "status": "ok",
            "durationMs": 4,
            "stdout": "report.txt\n",
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1);
    let text = text_of(&lines[0]);
    assert!(
        text.contains(
            "\u{2713} js \u{00b7} path.basename(\"/tmp/report.txt\") \u{00b7} \u{2191} 1 \u{2193} 1 lines \u{00b7} 4ms"
        ),
        "got: {text}"
    );
    assert!(!text.contains("javascript"), "must render js label: {text}");
    assert_eq!(
        count(
            &card,
            0,
            Detail::Overview,
            Detail::Overview,
            &theme(),
            100,
            true
        ),
        lines.len()
    );
}

#[test]
fn long_javascript_intent_moves_below_stable_status_row() {
    let code = "await agentObserve.recentMessages(\"mechanics-auditor\", { limit: 100, includeMetadata: true })";
    let stdout = (1..=11)
        .map(|i| format!("message {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let card = cell_card(
        code,
        json!({
            "status": "ok",
            "durationMs": 39,
            "stdout": stdout,
        }),
        false,
        false,
    );
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        80,
        true,
    );
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert_eq!(flat.len(), 2, "status + 1 intent row: {flat:?}");
    assert!(
        flat[0].contains("\u{2713} js \u{00b7} \u{2191} 1 \u{2193} 11 lines \u{00b7} 39ms"),
        "got: {flat:?}"
    );
    assert!(!flat[0].contains("agentObserve"), "got: {flat:?}");
    assert!(
        flat[1].starts_with(&format!(" {OUTPUT_INDENT}")),
        "indented by OUTPUT_INDENT: {flat:?}"
    );
    assert!(
        flat[1].contains("agentObserve.recentMessages(\"mechanics-auditor\", \u{2026})"),
        "compacted intent: {flat:?}"
    );
    assert!(
        !flat[1].contains("await "),
        "leading await stripped: {flat:?}"
    );
    assert!(
        lines[1]
            .iter()
            .any(|s| s.style == theme().fg_style(ThemeColor::SyntaxString)),
        "intent preview is syntax-highlighted"
    );
    assert_eq!(
        count(
            &card,
            0,
            Detail::Overview,
            Detail::Overview,
            &theme(),
            80,
            true
        ),
        lines.len()
    );
}

#[test]
fn narrow_javascript_intent_wraps_at_most_once_and_truncates_with_ellipsis() {
    let code = "agentObserve.recentMessages(\"mechanics-auditor-with-a-much-longer-name\")";
    let card = cell_card(
        code,
        json!({ "status": "ok", "durationMs": 39 }),
        false,
        false,
    );
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        30,
        true,
    );
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert_eq!(flat.len(), 3, "status + max 2 intent rows: {flat:?}");
    assert!(flat[0].contains("\u{2713} js"), "got: {flat:?}");
    assert!(
        flat[1..].iter().all(|row| !row.trim().is_empty()),
        "got: {flat:?}"
    );
    assert!(
        flat[2].trim_end().ends_with('\u{2026}'),
        "second wrapped row ends with ellipsis: {flat:?}"
    );
    assert!(
        flat.iter().all(|row| str_width(row) <= 30),
        "all rows within width: {flat:?}"
    );
    assert_eq!(
        count(
            &card,
            0,
            Detail::Overview,
            Detail::Overview,
            &theme(),
            30,
            true
        ),
        lines.len()
    );
}

#[test]
fn compact_javascript_intent_respects_strings_and_nested_brackets() {
    assert_eq!(
        compact_javascript_intent(
            "await agentObserve.recentMessages(\"mechanics-auditor\", { limit: 100 })"
        ),
        "agentObserve.recentMessages(\"mechanics-auditor\", \u{2026})"
    );
    assert_eq!(
        compact_javascript_intent("fn(\"a, b\", c)"),
        "fn(\"a, b\", \u{2026})"
    );
    assert_eq!(
        compact_javascript_intent("fn([1, 2], { a: 3 })"),
        "fn([1, 2], \u{2026})"
    );
    assert_eq!(
        compact_javascript_intent("await singleArg(42)"),
        "singleArg(42)"
    );
    assert_eq!(
        compact_javascript_intent("const x = compute(a, b)"),
        "const x = compute(a, b)"
    );
}

#[test]
fn expanded_source_remains_exact_and_status_row_stays_stable() {
    let code = "await agentObserve.recentMessages(\"mechanics-auditor\", { limit: 100, includeMetadata: true })";
    let card = cell_card(
        code,
        json!({ "status": "ok", "durationMs": 39 }),
        false,
        false,
    );
    let collapsed = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        80,
        true,
    );
    let expanded = render(&card, 0, Detail::All, Detail::All, &theme(), 80, true);
    assert_eq!(text_of(&collapsed[0]), text_of(&expanded[0]));
    let flat: Vec<String> = expanded.iter().map(text_of).collect();
    assert!(
        flat.iter()
            .any(|row| row.contains("\u{2570}\u{2500} await agentObserve.recentMessages")),
        "expanded source keeps leading await: {flat:?}"
    );
    assert!(
        flat.iter().any(|row| row.contains("includeMetadata: true")),
        "expanded source keeps full arguments: {flat:?}"
    );
    assert_eq!(
        count(&card, 0, Detail::All, Detail::All, &theme(), 80, true),
        expanded.len()
    );
}

#[test]
fn error_cell_summary_line() {
    let card = cell_card(
        "throw new TypeError('boom')",
        json!({
            "status": "error",
            "error": { "ename": "TypeError", "evalue": "boom", "traceback": [] },
        }),
        true,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    let text = text_of(&lines[0]);
    assert!(text.contains("\u{2717} js"), "got: {text}");
    assert!(text.contains("TypeError"), "got: {text}");
}

#[test]
fn expanded_renders_code_and_output() {
    let card = cell_card(
        "for (let i = 0; i < 3; i++) {\n  console.log(`line ${i}`);\n}",
        json!({
            "status": "ok",
            "durationMs": 3,
            "stdout": "line 0\nline 1\nline 2\n",
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat[1].starts_with(" \u{2570}\u{2500} for (let i = 0; i < 3; i++) {"),
        "got: {flat:?}"
    );
    assert!(
        flat[2].starts_with("      console.log(`line ${i}`);"),
        "got: {flat:?}"
    );
    assert_eq!(flat[4], "", "blank between code and output");
    assert!(flat[5].starts_with("  \u{203a} line 0"), "got: {flat:?}");
    assert!(flat[6].starts_with("    line 1"), "got: {flat:?}");
    assert_eq!(
        count(&card, 0, Detail::All, Detail::All, &theme(), 100, true),
        lines.len()
    );
}

#[test]
fn expanded_error_cell_shows_stack_trace() {
    let card = cell_card(
        "throw new TypeError('boom')",
        json!({
            "status": "error",
            "error": {
                "ename": "TypeError",
                "evalue": "boom",
                "traceback": ["TypeError: boom", "    at eval (<anonymous>:1:7)"],
            },
        }),
        true,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("TypeError: boom")),
        "got: {flat:?}"
    );
}

#[test]
fn sent_agent_messages_render_below_the_code() {
    let details = json!({
        "status": "ok",
        "durationMs": 3,
        "result": "{ id: \"agentmsg_1\", deliveryStatus: \"delivered\" }",
        "sentAgentMessages": [{
            "id": "agentmsg_1",
            "message": "Ping.\nThen report back.",
            "deliveryStatus": "delivered",
            "receiverRole": "parent",
            "target": {
                "activeSessionId": "worker-active",
                "sessionId": "worker-session",
                "sessionName": "Worker",
            },
        }],
    });
    let card = cell_card(
        "await agentMessage.send(\"Ping.\", { receiverRole: \"parent\" })",
        details,
        false,
        false,
    );
    let collapsed = render_card(&card, Detail::Overview);
    let flat: Vec<String> = collapsed.iter().map(text_of).collect();
    assert_eq!(flat.len(), 2, "top line + receipt summary: {flat:?}");
    assert!(
        flat[1]
            .trim_end()
            .starts_with(" \u{2709} Agent message \u{b7} \u{2191} Worker"),
        "got: {flat:?}"
    );
    assert!(!flat[1].contains("Ping."), "no body when collapsed");

    let expanded = render_card(&card, Detail::All);
    let flat: Vec<String> = expanded.iter().map(text_of).collect();
    let summary = flat
        .iter()
        .position(|row| row.contains("Agent message \u{b7} \u{2191} Worker"))
        .expect("summary row");
    assert_eq!(flat[summary - 1], "", "blank between code and receipt");
    assert_eq!(
        flat[summary].trim_end(),
        " \u{2709} Agent message \u{b7} \u{2191} Worker"
    );
    assert_eq!(flat[summary + 1], " \u{2570}\u{2500} Ping.");
    assert_eq!(flat[summary + 2], "    Then report back.");
    assert!(!flat.iter().any(|row| row.contains("agentmsg_1")));
    assert!(!flat.iter().any(|row| row.contains("deliveryStatus")));
}

#[test]
fn sent_agent_message_receipts_share_the_viewer_relative_arrow() {
    for delivery in ["delivered", "queued"] {
        let details = json!({
            "status": "ok",
            "sentAgentMessages": [{
                "id": "agentmsg_2",
                "message": "Ping.",
                "deliveryStatus": delivery,
                "receiverRole": "child",
                "target": { "activeSessionId": "worker-active", "sessionId": "worker-session" },
            }],
        });
        let card = cell_card("send()", details, false, false);
        let lines = render_card(&card, Detail::Overview);
        let text = text_of(&lines[1]);
        assert!(
            text.contains("\u{2709} Agent message \u{b7} \u{2191} worker-active"),
            "got: {text}"
        );
    }
    let details = json!({
        "status": "ok",
        "sentAgentMessages": [{
            "id": "agentmsg_3",
            "message": "Ping.",
            "deliveryStatus": "queued",
            "target": { "sessionId": "peer-session" },
        }],
    });
    let card = cell_card("send()", details, false, false);
    let lines = render_card(&card, Detail::Overview);
    assert!(
        text_of(&lines[1]).contains("Agent message \u{b7} \u{2191} peer-session"),
        "got: {}",
        text_of(&lines[1])
    );
    let details = json!({
        "status": "ok",
        "sentAgentMessages": [{ "id": "agentmsg_4" }, { "message": 1 }],
    });
    let card = cell_card("send()", details, false, false);
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1, "malformed receipts skipped: {lines:?}");
}

#[test]
fn collapsed_stays_single_line_for_short_js() {
    let card = cell_card(
        "console.log(1)",
        json!({ "status": "ok", "stdout": "1\n" }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    assert!(lines.len() > 1, "all mode expands rows");
    let collapsed = render_card(&card, Detail::Overview);
    let details = render_card(&card, Detail::Details);
    assert_eq!(collapsed.len(), 1);
    assert_eq!(details.len(), 1, "details mode keeps tool output collapsed");
}

#[test]
fn shell_template_renders_bash_label() {
    let card = cell_card(
        "await $`echo hi`",
        json!({ "status": "ok", "durationMs": 8, "stdout": "hi\n" }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat[0].contains("\u{2713} bash \u{00b7} echo hi"),
        "got: {flat:?}"
    );
    assert!(flat[1].contains("await $`echo hi`"), "got: {flat:?}");
}

#[test]
fn running_cell_summary_ticks_live_elapsed() {
    let mut card = cell_card(
        "await Bun.sleep(2000)",
        json!({ "status": "ok" }),
        false,
        true,
    );
    card.started_at = Some(
        std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(1500))
            .expect("the clock is past the start"),
    );
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        100,
        true,
    );
    let text = text_of(&lines[0]);
    assert!(text.contains("\u{2191} 1 lines"), "got: {text}");
    let duration_part = text.rsplit(" \u{00b7} ").next().unwrap_or_default();
    assert!(
        duration_part.ends_with('s') && duration_part.trim_end_matches('s').parse::<f64>().is_ok(),
        "the live duration ticks in its own slot: {text}"
    );
    assert!(!text.contains("Took "), "got: {text}");
}

#[test]
fn running_cell_long_preview_keeps_live_duration_visible() {
    let code = format!("console.log('{}')", "lorem ipsum ".repeat(8));
    let mut card = cell_card(&code, json!({ "status": "ok" }), false, true);
    card.started_at = Some(
        std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(1500))
            .expect("the clock is past the start"),
    );
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        80,
        true,
    );
    let text = text_of(&lines[0]);
    let duration_part = text.rsplit(" \u{00b7} ").next().unwrap_or_default();
    assert!(
        duration_part.ends_with('s') && duration_part.trim_end_matches('s').parse::<f64>().is_ok(),
        "the live duration stays on screen as its own segment: {text}"
    );
    assert!(str_width(&text) <= 80, "got: {text}");
}

#[test]
fn background_shell_duration_label_and_exit() {
    let code = "const h = bash('sleep 0.1')";
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 running command='sleep 0.1'>",
    });
    let card = cell_card(code, details, false, false);
    let lines = render_card(&card, Detail::Overview);
    let text = text_of(&lines[0]);
    assert!(text.contains("cell 12ms"), "got: {text}");
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 exit_code=1 command='sleep 0.1'>",
    });
    let card2 = cell_card(code, details, false, false);
    let lines = render_card(&card2, Detail::Overview);
    let text = text_of(&lines[0]);
    assert!(text.contains("exit 1"), "got: {text}");
    assert!(text.contains("\u{2717}"), "got: {text}");
}

#[test]
fn aborted_cell_never_renders_done_from_a_stale_exit_code() {
    let code = "const h = bash('sleep 0.1')";
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 exit_code=0 command='sleep 0.1'>",
    });
    let mut card = cell_card(code, details, false, false);
    card.aborted = true;
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        100,
        true,
    );
    let text = text_of(&lines[0]);
    assert!(text.contains("\u{2717}"), "got: {text}");
    assert!(!text.contains("\u{2713}"), "got: {text}");
}

#[test]
fn partial_cell_shows_waiting_for_output() {
    let card = cell_card("console.log(2)", json!({ "status": "ok" }), false, true);
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("waiting for output...")),
        "got: {flat:?}"
    );
}

fn image_cell_card() -> ToolCallCard {
    use base64::Engine;
    let mut bytes = vec![0x89, b'P', b'N', b'G'];
    bytes.extend(vec![0u8; 12]);
    bytes.extend(8u32.to_be_bytes());
    bytes.extend(4u32.to_be_bytes());
    let png = base64::engine::general_purpose::STANDARD.encode(bytes);
    ToolCallCard {
        id: "toolu_1".into(),
        name: "javascript".into(),
        args: json!({ "code": "attachImage('chart.png')" }),
        started: true,
        result: Some(super::super::ToolResultView {
            content: vec![json!({ "type": "image", "data": png, "mimeType": "image/png" })],
            details: json!({ "status": "ok", "durationMs": 3 }),
            is_error: false,
        }),
        result_partial: false,
        ..Default::default()
    }
}

#[test]
fn shown_image_counts_render_below_the_cell() {
    let card = image_cell_card();
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter()
            .any(|row| row.contains("1 image rendered below")),
        "got: {flat:?}"
    );
    assert!(
        flat.iter()
            .any(|row| row.contains("\u{2570}\u{2500} [image/png \u{b7} 8\u{d7}4]")),
        "got: {flat:?}"
    );
}

#[test]
fn hidden_image_counts_stay_hidden_with_no_rows() {
    let card = image_cell_card();
    let lines = render(&card, 0, Detail::All, Detail::All, &theme(), 100, false);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("1 image hidden")),
        "got: {flat:?}"
    );
    assert!(!flat.iter().any(|row| row.contains("[image/png")));
}

#[test]
fn no_output_placeholder() {
    let card = cell_card(
        "const x = 1",
        json!({ "status": "ok", "durationMs": 4 }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("no output")),
        "got: {flat:?}"
    );
}

#[test]
fn bash_dominated_cell_renders_as_bash() {
    let code =
        "const r = await sh(`\ncd crates/pa-tui\ncargo test -p pa-tui\n`);\nconsole.log(r.output);";
    let card = cell_card(
        code,
        json!({
            "status": "ok",
            "durationMs": 2,
            "stdout": "ok\n",
            "bashCommands": {
                "first": "\ncd crates/pa-tui\ncargo test -p pa-tui\n",
                "count": 3,
                "lines": 4,
            },
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1);
    assert_eq!(
        text_of(&lines[0]),
        " \u{2713} bash \u{00b7} cargo test -p pa-tui \u{00b7} +2 more \u{00b7} \u{2191} 5 \u{2193} 1 lines \u{00b7} 2ms"
    );
    assert_eq!(
        bash_dominated_stats(&card),
        Some(BashCellStats {
            bash_lines: 4,
            cell_lines: 5,
            count: 3,
        })
    );
}

#[test]
fn transcript_reads_render_one_summary_row_below_the_summary() {
    let read = |returned: u64, first: u64, roles: &[&str]| json!({ "returned": returned, "first": first, "total": 17, "roles": roles });
    for (reads, summary) in [
        (
            json!([read(5, 12, &["user"])]),
            "read 5 messages (role user) #12\u{2013}#16 of 17",
        ),
        (
            json!([read(3, 0, &["*"]), read(10, 7, &["user", "assistant"])]),
            "read 13 messages in 2 reads",
        ),
        (
            json!([{ "returned": 10, "first": 30, "total": 40, "roles": ["*"], "agent": "worker-a" }]),
            "read 10 messages from worker-a #30\u{2013}#39 of 40",
        ),
    ] {
        let card = cell_card(
            "const msgs = await rlm.session.messages({ role: 'user' })",
            json!({ "status": "ok", "durationMs": 40, "transcriptReads": reads }),
            false,
            false,
        );
        let rows: Vec<String> = render(
            &card,
            0,
            Detail::Overview,
            Detail::Overview,
            &theme(),
            100,
            true,
        )
        .iter()
        .map(text_of)
        .collect();
        assert_eq!(
            rows[1..],
            [format!(" \u{2261} transcript \u{b7} {summary}")]
        );
        for detail in [Detail::Overview, Detail::All] {
            assert_eq!(
                count(&card, 0, detail, detail, &theme(), 100, true),
                render(&card, 0, detail, detail, &theme(), 100, true).len(),
                "the row count matches the painted rows"
            );
        }
    }
}

#[test]
fn bash_minority_cell_stays_js() {
    let code = "async function run(cmd) {\n  return await bash(cmd);\n}\nconst r = await run(\"ls\");\nconsole.log(r.pid);";
    let card = cell_card(
        code,
        json!({
            "status": "ok",
            "durationMs": 5,
            "stdout": "0\n",
            "bashCommands": { "first": "ls", "count": 1, "lines": 1 },
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1);
    assert_eq!(
        text_of(&lines[0]),
        " \u{2713} js \u{00b7} const r = await run(\"ls\"); \u{00b7} \u{2191} 5 \u{2193} 1 lines \u{00b7} 5ms"
    );
    assert_eq!(bash_dominated_stats(&card), None);
}

fn edit_cell_card() -> ToolCallCard {
    cell_card(
        "await edit('src/app.ts', 'const x = 1', 'const x = 2')",
        json!({
            "status": "ok",
            "durationMs": 5,
            "result": "'Edited src/app.ts'",
            "diffs": [{ "path": "src/app.ts", "diff": "-10 const x = 1\n+10 const x = 2\n 11 const y = 3\n    ..." }],
        }),
        false,
        false,
    )
}

fn trimmed_rows(lines: &[Line]) -> Vec<String> {
    lines
        .iter()
        .skip(1)
        .map(|line| text_of(line).trim_end().to_string())
        .collect()
}

#[test]
fn edit_diffs_collapse_to_a_file_summary_line_in_overview() {
    let card = edit_cell_card();
    let summary = vec!["    \u{2570}\u{2500} src/app.ts +1 -1".to_string()];
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        100,
        true,
    );
    assert_eq!(trimmed_rows(&lines), summary);
    // A click-expanded card keeps the conversation level's collapsed diff.
    let toggled = render(&card, 0, Detail::All, Detail::Overview, &theme(), 100, true);
    assert!(!trimmed_rows(&toggled)
        .iter()
        .any(|row| row.contains("10 + const x = 2")));
}

#[test]
fn edit_diffs_expand_to_numbered_rows_in_details_with_ts_highlighting() {
    let card = edit_cell_card();
    let lines = render(
        &card,
        0,
        Detail::Details,
        Detail::Details,
        &theme(),
        100,
        true,
    );
    assert_eq!(
        trimmed_rows(&lines),
        vec![
            "    \u{2570}\u{2500} src/app.ts +1 -1".to_string(),
            "  10 - const x = 1".to_string(),
            "  10 + const x = 2".to_string(),
            "  11   const y = 3".to_string(),
            "       ...".to_string(),
        ]
    );
    // Full-width rows on the diff backgrounds, with JS keyword syntax highlighting.
    assert_eq!(text_of(&lines[2]).chars().count(), 100);
    assert_eq!(
        lines[3][1].style,
        theme()
            .fg_style(ThemeColor::ToolDiffAdded)
            .patch(theme().bg_style(crate::theme::ThemeBg::ToolDiffAddedBg))
    );
    assert!(
        lines[3].iter().any(|s| s.content == "const"
            && s.style.fg == theme().fg_style(ThemeColor::SyntaxKeyword).fg),
        "ts diff highlights keywords: {:?}",
        lines[3]
    );
    assert_eq!(
        count(
            &card,
            0,
            Detail::Details,
            Detail::Details,
            &theme(),
            100,
            true
        ),
        lines.len()
    );
}

#[test]
fn an_aborted_cell_freezes_its_duration_from_card_timestamps() {
    let now = std::time::Instant::now();
    let mut card = cell_card("console.log('x')", Value::Null, true, false);
    card.started_at = now.checked_sub(std::time::Duration::from_secs(4));
    card.ended_at = now.checked_sub(std::time::Duration::from_secs(1));
    card.aborted = true;
    let first = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        100,
        true,
    );
    let later = render(
        &card,
        10,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        100,
        true,
    );
    assert_eq!(
        first, later,
        "a settled timer never repaints a different duration"
    );
    assert!(text_of(&first[0]).contains("3.0s"), "got: {first:?}");
}
