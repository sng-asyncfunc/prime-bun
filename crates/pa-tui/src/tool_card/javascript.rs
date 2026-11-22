//! The `javascript` tool-call card: an adaptive collapsed summary (marker,
//! `js`/`bash` label, syntax-highlighted intent preview — inline when short or
//! up to two indented rows below the status row when long — line counts,
//! duration, error name), per-file edit summaries (with diff rows when edit
//! diffs expand), plus in expanded mode the full cell source and output.
//! The summary rows never change with expansion, so toggling detail never
//! shifts the status row.

mod diffs;
mod output;

use diffs::render_diffs;
use output::render_output;
use serde_json::Value;

use super::javascript_details::{
    format_duration, is_agent_message_receipt, is_edit_confirmation, parse_sent_agent_message,
    read_background_shell, transcript_reads_summary, BackgroundShell, BashCommands,
    JavaScriptDetails, JavaScriptError,
};
use super::layout::RowOutput;
use super::{highlight, ToolCallCard};
use crate::chat::Detail;
use crate::code_preview::{preview_bash_command, preview_javascript_code, CodePreviewLanguage};
use crate::custom_message::AgentMessageDirection;
use crate::error_summary::{normalize_error_details, summarize_error_details};
use crate::theme::{Theme, ThemeColor};
use crate::width::{line_width, str_width, truncate_line, wrap_line};
use crate::{Line, Span};

/// The output continuation indent (TS `OUTPUT_INDENT`).
const OUTPUT_INDENT: &str = "   ";

/// Maximum wrapped intent-preview rows when a long JS preview moves below the status row.
const MAX_INTENT_PREVIEW_ROWS: usize = 2;

/// The card status (TS `statusKind`).
enum CardStatus {
    Queued,
    Running,
    Done,
    Error,
    Aborted,
}

impl CardStatus {
    fn of(card: &ToolCallCard, details: &JavaScriptDetails) -> CardStatus {
        // An interrupted cell never renders as a success: a settled
        // straggler's kept partial can still carry a background shell
        // whose exit code reads Done, and the aborted stamp is the
        // truth the exit code never saw.
        if card.aborted {
            return CardStatus::Aborted;
        }
        let result = card.result.as_ref();
        let is_error = result.is_some_and(|r| r.is_error);
        if !card.result_partial {
            if let Some(background) =
                result.and_then(|r| read_background_shell(cell_code(card), &r.details))
            {
                return match background.exit_code {
                    Some(0) => CardStatus::Done,
                    Some(_) => CardStatus::Error,
                    None => CardStatus::Running,
                };
            }
        }
        let status = details.status.as_deref();
        if is_error || status == Some("error") {
            return CardStatus::Error;
        }
        if status == Some("aborted") {
            return CardStatus::Aborted;
        }
        let has_result = result.is_some_and(|r| {
            details.stdout.is_some()
                || details.stderr.is_some()
                || details.result.is_some()
                || details.error.is_some()
                || !details.diffs.is_empty()
                || !details.sent_agent_messages.is_empty()
                || !r.content.is_empty()
        });
        if !card.result_partial && (status.is_some() || card.started || has_result) {
            return CardStatus::Done;
        }
        if card.result_partial || card.started {
            CardStatus::Running
        } else {
            CardStatus::Queued
        }
    }
}

/// Whether the cell's final result carries a still-running background
/// shell: the summary line keeps animating — the card's rows must not
/// cache.
pub(crate) fn background_shell_running(card: &ToolCallCard) -> bool {
    if card.result_partial {
        return false;
    }
    card.result
        .as_ref()
        .and_then(|result| read_background_shell(cell_code(card), &result.details))
        .is_some_and(|background| background.exit_code.is_none())
}

fn cell_code(card: &ToolCallCard) -> &str {
    card.args
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Compact a JavaScript preview statement for display-only intent: strip a
/// leading `await ` and collapse trailing arguments after the first top-level
/// comma to `, …)` while respecting strings and nested brackets.
pub(crate) fn compact_javascript_intent(text: &str) -> String {
    let compact = text
        .strip_prefix("await")
        .filter(|rest| rest.chars().next().is_some_and(char::is_whitespace))
        .map_or(text, str::trim_start);

    // Match callee prefix: `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(`.
    let Some(open_paren) = leading_callee_open_paren(compact) else {
        return compact.to_string();
    };

    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut depth = 0usize;

    for (offset, ch) in compact[open_paren + 1..].char_indices() {
        let index = open_paren + 1 + offset;
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }

        match ch {
            '\'' | '"' | '`' => quote = Some(ch),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                return format!("{}, \u{2026})", compact[..index].trim_end());
            }
            _ => {}
        }
    }

    compact.to_string()
}

fn leading_callee_open_paren(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    loop {
        let first = *bytes.get(i)?;
        if !(first.is_ascii_alphabetic() || first == b'_' || first == b'$') {
            return None;
        }
        i += 1;
        while let Some(&b) = bytes.get(i) {
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'$' {
                i += 1;
            } else {
                break;
            }
        }
        match bytes.get(i) {
            Some(b'.') => i += 1,
            Some(b'(') => return Some(i),
            _ => return None,
        }
    }
}

fn highlight_input_line(line: &str, theme: &Theme) -> Line {
    let palette = highlight::SyntaxPalette::from_theme(theme);
    highlight::highlight_javascript(line, &palette)
        .into_iter()
        .next()
        .filter(|spans| !spans.is_empty())
        .unwrap_or_else(|| {
            vec![Span::styled(
                line.to_string(),
                theme.fg_style(ThemeColor::MdCodeBlock),
            )]
        })
}

/// Render the `javascript` cell card: the adaptive summary (1 row inline, or
/// status row + up to 2 indented intent rows when a long JS preview overflows
/// `width`), edit summaries, then the expanded code and output rows when the
/// card's `detail` is `all`. Edit diff rows and sent agent messages' bodies
/// follow the conversation `level`, never a card's own click toggle.
#[must_use]
pub fn render(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    level: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> Vec<Line> {
    let mut lines = RowOutput::paint();
    layout(
        card,
        frame,
        detail,
        level,
        theme,
        width,
        show_images,
        &mut lines,
    );
    lines.into_lines()
}

pub(super) fn count(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    level: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> usize {
    let mut lines = RowOutput::count();
    layout(
        card,
        frame,
        detail,
        level,
        theme,
        width,
        show_images,
        &mut lines,
    );
    lines.len()
}

// One more than clippy's limit: the paint/count sink rides beside the
// render inputs so both traversals share this single layout.
#[allow(clippy::too_many_arguments)]
fn layout(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    level: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
    lines: &mut RowOutput,
) {
    let code = cell_code(card).trim_end();
    let details = card.result.as_ref().map_or_else(
        || JavaScriptDetails::parse(&Value::Null),
        |result| JavaScriptDetails::parse(&result.details),
    );
    let background = card
        .result
        .as_ref()
        .and_then(|result| read_background_shell(code, &result.details));

    collapsed_lines(
        card,
        &details,
        background.as_ref(),
        frame,
        theme,
        width,
        code,
        lines,
    );
    // Edit summaries, sent-message receipts, and transcript reads show even
    // when the cell is collapsed; code and output open up only when
    // expanded. The sent messages are agent messages of their own, so their
    // bodies follow the conversation level, not a click on the card.
    let expanded = detail.tool_output_expanded();
    let has_code = expanded && render_code(lines, code, theme, width);
    render_diffs(
        lines,
        &details.diffs,
        has_code,
        level.edit_diffs_expanded(),
        theme,
        width,
    );
    render_sent_agent_messages(lines, &details, level.tool_output_expanded(), theme, width);
    render_transcript_reads(lines, &details, expanded, theme, width);
    if !expanded {
        return;
    }
    render_output(card, &details, lines, has_code, show_images, theme, width);
    // Image blocks render below the card when shown (TS adds these rows
    // for every tool shell).
    lines.images(card.result.as_ref(), show_images, theme);
}

/// The adaptive collapsed summary (TS `collapsedLines`): keeps short previews
/// inline on the status row; moves overflowing JavaScript intent previews below
/// the status row indented by `OUTPUT_INDENT` (max 2 rows). Both counting and
/// painting traverse the exact same branches so `count()` matches `render()`.
#[allow(clippy::too_many_arguments)]
fn collapsed_lines(
    card: &ToolCallCard,
    details: &JavaScriptDetails,
    background: Option<&BackgroundShell>,
    frame: usize,
    theme: &Theme,
    width: usize,
    code: &str,
    lines: &mut RowOutput,
) {
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let error = theme.fg_style(ThemeColor::Error);
    let warning = theme.fg_style(ThemeColor::Warning);
    let success = theme.fg_style(ThemeColor::Success);
    let bash_mode = theme.fg_style(ThemeColor::BashMode);

    let dominant = dominant_bash(details, code);
    let preview = preview_javascript_code(code);
    let language_label = if dominant.is_some() || preview.language == CodePreviewLanguage::Bash {
        "bash"
    } else {
        "js"
    };

    let mut heading: Line = match CardStatus::of(card, details) {
        CardStatus::Error => vec![Span::styled("\u{2717}".to_string(), error)],
        CardStatus::Aborted => vec![Span::styled("\u{2717}".to_string(), warning)],
        CardStatus::Done => vec![Span::styled("\u{2713}".to_string(), success)],
        CardStatus::Running => vec![Span::styled(
            super::working_icon(frame).to_string(),
            bash_mode,
        )],
        CardStatus::Queued => vec![Span::styled("\u{25c7}".to_string(), muted)],
    };
    heading.push(Span::raw(" "));
    heading.push(Span::styled(language_label.to_string(), muted));

    let mut is_js_preview = false;
    let mut intent: Option<Line> = None;
    let mut metadata: Vec<Line> = Vec::new();

    if let Some(bash) = dominant {
        let bash_preview = preview_bash_command(&bash.first);
        if !bash_preview.text.is_empty() {
            intent = Some(vec![Span::styled(bash_preview.text, dim)]);
        }
        if bash.count > 1 {
            metadata.push(vec![Span::styled(format!("+{} more", bash.count - 1), dim)]);
        }
    } else if !preview.text.is_empty() {
        match preview.language {
            CodePreviewLanguage::Bash => {
                intent = Some(vec![Span::styled(preview.text, dim)]);
            }
            CodePreviewLanguage::JavaScript => {
                is_js_preview = true;
                let compacted = compact_javascript_intent(&preview.text);
                intent = Some(highlight_input_line(&compacted, theme));
            }
        }
    } else if !card.started {
        intent = Some(vec![Span::styled("waiting for code".to_string(), dim)]);
    }

    if let Some(counts) = line_counts(card, details, code) {
        metadata.push(vec![Span::styled(counts, dim)]);
    }
    let mut live_timer = false;
    if let Some(duration) = details.duration_ms {
        let label = if background.is_some() {
            format!("cell {}", format_duration(duration))
        } else {
            format_duration(duration)
        };
        metadata.push(vec![Span::styled(label, dim)]);
    } else if let Some(started) = card
        .started_at
        .filter(|_| card.ended_at.is_none() || card.aborted)
    {
        let elapsed = card.ended_at.unwrap_or_else(std::time::Instant::now) - started;
        metadata.push(vec![Span::styled(
            format_duration(elapsed.as_millis() as f64),
            dim,
        )]);
        live_timer = card.ended_at.is_none();
    }
    if !card.result_partial {
        let error_name = details
            .error
            .as_ref()
            .map(|e| e.ename.clone())
            .or_else(|| details.error_ename.clone());
        if let Some(ename) = error_name {
            metadata.push(vec![Span::styled(ename, error)]);
        }
    }
    if let Some(exit_code) = background.and_then(|shell| shell.exit_code) {
        if exit_code != 0 {
            metadata.push(vec![Span::styled(format!("exit {exit_code}"), error)]);
        }
    }

    let separator_width = str_width(" \u{00b7} ");
    let inline_parts_len = 1 + usize::from(intent.is_some()) + metadata.len();
    let inline_width = 1
        + line_width(&heading)
        + intent.as_ref().map_or(0, |line| line_width(line))
        + metadata.iter().map(|part| line_width(part)).sum::<usize>()
        + separator_width * inline_parts_len.saturating_sub(1);

    if is_js_preview && inline_width > width {
        let intent_line = intent.as_ref().expect("is_js_preview implies Some(intent)");
        lines.push(|| {
            let mut row: Line = vec![Span::raw(" ")];
            row.extend(heading.iter().cloned());
            for part in &metadata {
                row.push(Span::styled(" \u{00b7} ".to_string(), dim));
                row.extend(part.iter().cloned());
            }
            truncate_line(&row, width, "")
        });
        let indent_prefix = vec![Span::raw(OUTPUT_INDENT)];
        add_wrapped_limited(
            lines,
            &indent_prefix,
            intent_line,
            width,
            MAX_INTENT_PREVIEW_ROWS,
        );
        return;
    }

    // Inline layout (short JS preview, bash preview, waiting for code, or empty).
    lines.push(|| {
        let mut parts: Vec<Line> = Vec::with_capacity(inline_parts_len);
        parts.push(heading);
        let preview_index = if let Some(intent_line) = intent {
            let idx = parts.len();
            parts.push(intent_line);
            Some(idx)
        } else {
            None
        };
        parts.extend(metadata);

        // For non-JS live timers (e.g. bash-dominated running cells), shorten
        // the inline preview so the ticking duration stays visible.
        if live_timer && inline_width > width {
            let excess = inline_width - width;
            match preview_index {
                Some(index) if line_width(&parts[index]) > excess => {
                    let target = line_width(&parts[index]) - excess;
                    parts[index] = truncate_line(&parts[index], target, "");
                }
                Some(index) => {
                    parts.remove(index);
                }
                None => {}
            }
        }

        let mut row: Line = vec![Span::raw(" ")];
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                row.push(Span::styled(" \u{00b7} ".to_string(), dim));
            }
            row.extend(part.iter().cloned());
        }
        truncate_line(&row, width, "")
    });
}

/// A cell renders as bash when its executed `bash()`/`sh()` lines are at least
/// `1/BASH_DOMINANCE_DIVISOR` of the cell's non-blank lines. 2 means the bash
/// lines are at least as many as the remaining JS lines (B >= J - B):
/// literal commands also appear in the cell source, so J - B estimates
/// the non-bash JS.
const BASH_DOMINANCE_DIVISOR: usize = 2;

fn input_line_count(code: &str) -> usize {
    code.lines().filter(|line| !line.trim().is_empty()).count()
}

fn dominant_bash<'a>(details: &'a JavaScriptDetails, code: &str) -> Option<&'a BashCommands> {
    details
        .bash_commands
        .as_ref()
        .filter(|bash| bash.lines * BASH_DOMINANCE_DIVISOR >= input_line_count(code))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BashCellStats {
    pub(crate) bash_lines: usize,
    pub(crate) cell_lines: usize,
    pub(crate) count: usize,
}

/// The bash stats of a settled `javascript` card that renders as bash.
pub(crate) fn bash_dominated_stats(card: &ToolCallCard) -> Option<BashCellStats> {
    let code = cell_code(card).trim_end();
    let details = JavaScriptDetails::parse(&card.result.as_ref()?.details);
    let bash = dominant_bash(&details, code)?;
    Some(BashCellStats {
        bash_lines: bash.lines,
        cell_lines: input_line_count(code),
        count: bash.count,
    })
}

/// `\u{2191}in \u{2193}out lines` (TS `lineCounts`): non-empty input
/// lines; output from the structured fields (edits show the diff, so
/// count zero).
fn line_counts(card: &ToolCallCard, details: &JavaScriptDetails, code: &str) -> Option<String> {
    let input = input_line_count(code);
    let has_diffs = !details.diffs.is_empty();

    let result =
        if is_agent_message_receipt(details.result.as_deref(), &details.sent_agent_messages) {
            None
        } else {
            details.result.as_deref()
        };
    let structured = [
        details.stdout.as_deref(),
        details.stderr.as_deref(),
        result,
        details.background_output.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|text| !text.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let blocks_text = text_from_blocks(card);
    let fallback =
        if is_agent_message_receipt(Some(blocks_text.as_str()), &details.sent_agent_messages) {
            String::new()
        } else {
            blocks_text
        };
    let output_text = if structured.trim().is_empty() {
        fallback
    } else {
        structured
    };
    let output = if has_diffs || output_text.trim().is_empty() {
        0
    } else {
        output_text.trim().lines().count()
    };

    let mut segments: Vec<String> = Vec::new();
    if input > 0 {
        segments.push(format!("\u{2191} {input}"));
    }
    if output > 0 {
        segments.push(format!("\u{2193} {output}"));
    }
    if segments.is_empty() {
        None
    } else {
        Some(format!("{} lines", segments.join(" ")))
    }
}

/// The text of the result's text blocks (TS `textFromBlocks`).
fn text_from_blocks(card: &ToolCallCard) -> String {
    card.result
        .as_ref()
        .map(|result| {
            result
                .content
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .map(|block| {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The expanded source rows (TS `renderCode`): the first line guttered
/// `\u{2570}\u{2500}`, continuation lines indented; JavaScript lines syntax
/// highlighted verbatim (never compacted).
fn render_code(lines: &mut RowOutput, code: &str, theme: &Theme, width: usize) -> bool {
    if code.is_empty() {
        add_wrapped(
            lines,
            &vec![Span::styled(
                "\u{2570}\u{2500} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )],
            &vec![Span::styled(
                "waiting for code".to_string(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        );
        return false;
    }
    let raw_lines: Vec<&str> = code.split('\n').collect();
    let highlighted =
        highlight::highlight_javascript(code, &highlight::SyntaxPalette::from_theme(theme));
    for (index, raw_line) in raw_lines.iter().enumerate() {
        let prefix: Line = if index == 0 {
            vec![Span::styled(
                "\u{2570}\u{2500} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )]
        } else {
            vec![Span::raw(OUTPUT_INDENT)]
        };
        let body: Line = highlighted.get(index).cloned().unwrap_or_else(|| {
            vec![Span::styled(
                (*raw_line).to_string(),
                theme.fg_style(ThemeColor::MdCodeBlock),
            )]
        });
        let body = if body.is_empty() {
            vec![Span::raw(" ")]
        } else {
            body
        };
        add_wrapped(lines, &prefix, &body, width);
    }
    true
}

/// TS `renderSentAgentMessages`: one summary row per sent receipt, the
/// `╰─`-guttered body only in the expanded view (the TS sent rows are
/// the receipt summary alone).
fn render_sent_agent_messages(
    lines: &mut RowOutput,
    details: &JavaScriptDetails,
    expanded: bool,
    theme: &Theme,
    width: usize,
) {
    for sent in &details.sent_agent_messages {
        let Some(sent) = parse_sent_agent_message(sent) else {
            continue;
        };
        if expanded {
            lines.blank();
        }
        let direction = if sent.delivered {
            AgentMessageDirection::Sent
        } else {
            AgentMessageDirection::Queued
        };
        // TS: truncateToWidth(summary, max(1, width - 1), "…") then the
        // one-space `addPlain` margin.
        lines.push(|| {
            let summary = crate::custom_message::render::agent_message_summary_line(
                direction,
                &sent.counterpart,
                theme,
            );
            let mut row: Line = vec![Span::raw(" ")];
            row.extend(truncate_line(
                &summary,
                width.saturating_sub(1).max(1),
                "\u{2026}",
            ));
            row
        });
        if expanded {
            if lines.is_counting() {
                lines.add_count(crate::custom_message::agent_message_body_count(
                    &sent.message,
                    width,
                ));
            } else {
                for row in
                    crate::custom_message::render::agent_message_body(&sent.message, theme, width)
                {
                    lines.push(|| row);
                }
            }
        }
    }
}

/// One summary row for the cell's `rlm.session.messages` reads, shaped like
/// the sent agent-message rows; the expanded view sets it off from the code.
fn render_transcript_reads(
    lines: &mut RowOutput,
    details: &JavaScriptDetails,
    expanded: bool,
    theme: &Theme,
    width: usize,
) {
    if let Some(summary) = transcript_reads_summary(&details.transcript_reads) {
        if expanded {
            lines.blank();
        }
        lines.push(|| {
            let row: Line = vec![
                Span::raw(" "),
                Span::styled(
                    "\u{2261} transcript".to_string(),
                    theme.fg_style(ThemeColor::Muted),
                ),
                Span::styled(" \u{b7} ".to_string(), theme.fg_style(ThemeColor::Dim)),
                Span::styled(summary, theme.fg_style(ThemeColor::Dim)),
            ];
            truncate_line(&row, width, "\u{2026}")
        });
    }
}

/// One indented card row (TS `addWrapped`): the first wrapped row carries
/// `prefix`, continuation rows the matching indent; each row truncates
/// to the width.
fn add_wrapped(lines: &mut RowOutput, prefix: &Line, body: &Line, width: usize) {
    let prefix_width: usize = prefix.iter().map(|s| str_width(&s.content)).sum();
    let available = width.saturating_sub(1 + prefix_width).max(1);
    if lines.is_counting() {
        lines.add_count(crate::width::wrapped_line_count(body, available).max(1));
        return;
    }
    let wrapped = wrap_line(body, available);
    let mut rows: Vec<Line> = Vec::new();
    if wrapped.is_empty() {
        rows.push(Vec::new());
    } else {
        rows.extend(wrapped);
    }
    for (index, mut row) in rows.into_iter().enumerate() {
        let mut line: Line = vec![Span::raw(" ")];
        if index == 0 {
            line.extend(prefix.iter().cloned());
        } else {
            line.push(Span::raw(" ".repeat(prefix_width)));
        }
        line.append(&mut row);
        lines.push(|| truncate_line(&line, width, ""));
    }
}

/// Bounded wrapped rows (TS `addWrappedLimited`): wraps at most `max_lines`
/// rows and appends `…` on the final row when content overflows. Counting and
/// painting emit identical row counts.
fn add_wrapped_limited(
    lines: &mut RowOutput,
    prefix: &Line,
    body: &Line,
    width: usize,
    max_lines: usize,
) {
    let max_lines = max_lines.max(1);
    let prefix_width: usize = prefix.iter().map(|s| str_width(&s.content)).sum();
    let available = width.saturating_sub(1 + prefix_width).max(1);
    if lines.is_counting() {
        let wrapped_count = crate::width::wrapped_line_count(body, available).max(1);
        lines.add_count(wrapped_count.min(max_lines));
        return;
    }
    let wrapped = wrap_line(body, available);
    let total = wrapped.len();
    let visible_rows: Vec<Line> = if wrapped.is_empty() {
        vec![Vec::new()]
    } else {
        wrapped.into_iter().take(max_lines).collect()
    };
    let truncated = total > max_lines;
    for (index, row) in visible_rows.into_iter().enumerate() {
        let mut content = if index + 1 == max_lines && truncated {
            let mut with_ellipsis = row;
            with_ellipsis.push(Span::raw("\u{2026}"));
            truncate_line(&with_ellipsis, available, "\u{2026}")
        } else {
            row
        };
        let mut line: Line = vec![Span::raw(" ")];
        if index == 0 {
            line.extend(prefix.iter().cloned());
        } else {
            line.push(Span::raw(" ".repeat(prefix_width)));
        }
        line.append(&mut content);
        lines.push(|| truncate_line(&line, width, ""));
    }
}

#[cfg(test)]
mod tests;
