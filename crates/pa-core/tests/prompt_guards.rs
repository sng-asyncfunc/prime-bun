// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Prompt guard tests: cache safety (static layers never contain dynamic content; the cached prefix
//! is byte-identical across sessions) and tool surface (the core layer's documented tools match the
//! real registered surface; a tool change without a prompt update fails here).

use std::collections::BTreeSet;
use std::path::Path;

use pa_core::prompts::layers::{CORE_LAYER, OPINIONATED_LAYER, USAGE_LAYER};
use pa_core::prompts::model_prompts::MODEL_PROMPTS_TOML;
use pa_core::prompts::system_prompt::{
    system_prompt_breakdown, BuildSystemPromptOptions, SegmentKind,
};
use pa_core::skills::load_skills_from_dir;

/// The workspace bundled skills directory (source-checkout layout):
/// pa-core lives at `<root>/crates/pa-core`.
fn bundled_skills_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .join("skills")
}

fn sorted_bundled_skills() -> Vec<pa_core::skills::Skill> {
    let skills_dir = bundled_skills_dir();
    let mut loaded = load_skills_from_dir(&skills_dir, "package");
    loaded
        .skills
        .sort_by(|left, right| left.name.cmp(&right.name));
    loaded.skills
}

// Cache safety

/// Strings that only dynamic segments generate. If one of these ever appears in a static layer
/// file, the cached prefix has started leaking per-session content.
const DYNAMIC_ONLY_MARKERS: &[&str] = &[
    "Working directory:",
    "Conversation log:",
    "Recursive agent depth:",
    "Current date:",
    "<available_skills>",
    "Enabled generic MCP servers:",
    "# Project Context",
    "Preloaded Bun/JavaScript globals:",
    "You are a child agent spawned by",
];

#[test]
fn static_layers_contain_no_dynamic_content() {
    for (name, text) in [
        ("core", CORE_LAYER),
        ("usage", USAGE_LAYER),
        ("opinionated", OPINIONATED_LAYER),
        ("model-prompts", MODEL_PROMPTS_TOML),
    ] {
        for marker in DYNAMIC_ONLY_MARKERS {
            assert!(
                !text.contains(marker),
                "static layer {name} contains dynamic-only marker {marker:?}: \
                 dynamic content must stay in the tail, not the cacheable prefix"
            );
        }
    }
}

#[test]
fn cached_prefix_is_stable_across_sessions() {
    let mut options = BuildSystemPromptOptions {
        cwd: "/first/cwd".to_string(),
        messages_path: Some("/first/session.jsonl".to_string()),
        model_prompt_extras: Some("model guidance."),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["javascript"]),
        ..Default::default()
    };
    let first = system_prompt_breakdown(&options);

    options.cwd = "/completely/different".into();
    options.messages_path = None;
    options.rlm_depth = Some(3);
    options.rlm_parent_agent = Some("orchestrator");
    options.generic_mcp_servers = vec!["slack".into(), "github".into()];
    options.context_files = vec![("AGENTS.md".into(), "Never commit main.".into())];
    options.append_system_prompt = Some("And one more thing.".into());
    let second = system_prompt_breakdown(&options);

    assert_eq!(first.cached_prefix_len, second.cached_prefix_len);
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &second.assembled[..second.cached_prefix_len]
    );
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &format!(
            "{}\n\n{}\n\n{}\n\nmodel guidance.",
            CORE_LAYER.trim(),
            USAGE_LAYER.trim(),
            OPINIONATED_LAYER.trim()
        )
    );

    let first_tail = &first.assembled[first.cached_prefix_len..];
    assert!(first_tail.contains("Current date: "));
    assert!(first_tail.contains("Working directory: /first/cwd"));
    assert!(first_tail.contains("Recursive agent depth: 0 (root)"));
    assert!(first_tail.contains("<available_skills>"));
    assert!(first_tail.contains("Preloaded Bun/JavaScript globals:"));
    let second_tail = &second.assembled[second.cached_prefix_len..];
    assert!(second_tail.contains("/completely/different"));
    assert!(second_tail.contains("Enabled generic MCP servers: `github`, `slack`."));
    assert!(second_tail.contains("Recursive agent depth: 3 (not root)"));
    assert!(second_tail.contains("You are a child agent spawned by orchestrator."));
    assert!(second_tail.contains("# Project Context"));
    assert!(second_tail.ends_with("And one more thing."));

    for segment in &first.segments {
        let inside = first
            .assembled
            .find(&segment.text)
            .is_some_and(|at| at < first.cached_prefix_len);
        assert_eq!(
            inside,
            segment.kind == SegmentKind::Static,
            "segment {} on the wrong side of the cache boundary",
            segment.name
        );
    }
}

// Tool surface

/// Host-request types that are host-internal plumbing, not model-facing
/// programmatic tools (the prompt must not document them).
const INTERNAL_HOST_REQUESTS: &[&str] = &[
    "model.info",
    "mcp.config",
    "mcp.refresh",
    "mcp.begin_login",
    // The runtime's detached-bash notice pair (the kernel's bash module
    // fires them; the model never calls them).
    "bash.completed",
    "bash.consumed",
    // The factory module reports run milestones; the model never calls it.
    "factory.progress",
];

/// Map one registered host-request type to the prompt token that documents
/// it. `None` when the request is host-internal.
fn prompt_token_for_host_request(request: &str) -> Option<String> {
    if INTERNAL_HOST_REQUESTS.contains(&request) {
        return None;
    }
    Some(
        match request {
            "rlm.run" => "rlm.spawn",
            "rlm.create_session" => "rlm.createSession",
            "rlm.find_models" => "rlm.findModels",
            "rlm.list_subagents" => "rlm.listSubagents",
            "rlm.delete_subagent" => "rlm.deleteSubagent",
            "rlm.progress.note" => "rlm.progressNote",
            "rlm.end_turn" => "rlm.endTurn",
            "agent_message.send" => "agentMessage.send",
            "agent_observe.list" | "agent_message.list_agents" => "agentObserve.listAgents",
            "agent_observe.get" => "agentObserve.getAgent",
            "agent_observe.recent" => "agentObserve.recentMessages",
            "agent_observe.session_messages" => "rlm.session.messages",
            "rlm_heartbeat.create" => "rlmHeartbeat.create",
            "rlm_heartbeat.list" => "rlmHeartbeat.list",
            "rlm_heartbeat.update" => "rlmHeartbeat.update",
            "rlm_heartbeat.delete" => "rlmHeartbeat.delete",
            "mcp.list_plugins" => "mcp.listPlugins",
            "mcp.search_plugins" => "mcp.searchPlugins",
            "mcp.list_connections" => "mcp.listConnections",
            "mcp.search_tools" => "mcp.searchTools",
            "mcp.describe_tool" => "mcp.describeTool",
            "mcp.list_tools" => "mcp.listTools",
            "mcp.call_tool" => "mcp.callTool",
            other => other,
        }
        .to_string(),
    )
}

/// Kernel-side programmatic tools implemented by the vendored `prime-agent-runtime` package
/// (generic MCP calls and built-in REPL helpers). Update together with the runtime sidecar.
const KERNEL_LOCAL_TOKENS: &[&str] = &[
    "bash",
    "sh",
    "installPackage",
    "mcp.listTools",
    "mcp.callTool",
    "mcp.searchTools",
    "mcp.describeTool",
    "mcp.listPlugins",
    "mcp.searchPlugins",
    "mcp.listConnections",
];

/// The vendored runtime's harness-state API (`rlm.harness` CRUD and
/// `rlm.getHarnessState`) plus its sanctioned terminal turn call
/// (`rlm.endTurn`). Update together with the runtime sidecar.
const HARNESS_TOKENS: &[&str] = &[
    "rlm.endTurn",
    "rlm.harness.createMemory",
    "rlm.harness.updateMemory",
    "rlm.harness.deleteMemory",
    "rlm.harness.createPromptNote",
    "rlm.harness.updatePromptNote",
    "rlm.harness.deletePromptNote",
    "rlm.harness.createSkill",
    "rlm.harness.updateSkill",
    "rlm.harness.deleteSkill",
    "rlm.harness.createSubagent",
    "rlm.harness.updateSubagent",
    "rlm.harness.deleteSubagent",
    "rlm.harness.createFactory",
    "rlm.harness.updateFactory",
    "rlm.harness.deleteFactory",
    "rlm.harness.recordRefinement",
    "rlm.harness.planRefinement",
    "rlm.harness.overview",
    "rlm.harness.search",
    "rlm.getHarnessState",
];

/// A host-request type literal: lowercase dotted name (`rlm.collect`).
fn is_request_type_literal(literal: &str) -> bool {
    !literal.is_empty()
        && literal
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase())
        && literal
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '.')
        && literal.contains('.')
}

/// Scan the pa-core sources for every host-request type the session engine
/// registers: `handlers.register("<type>", ...)` literals plus
/// `for request_type in [ "<type>", ... ]` loop tables.
fn registered_host_requests() -> BTreeSet<String> {
    let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = BTreeSet::new();
    let mut stack = vec![src_root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read source");
            // Direct registrations: the request type is the FIRST
            // argument of each `.register(` — a literal right at the
            // call's head counts; anything after a non-literal first
            // argument is not the request type.
            for remainder in source.split(".register(").skip(1) {
                let rest = remainder.trim_start();
                if rest.starts_with('"') {
                    if let Some(literal) = first_string_literal(rest) {
                        if is_request_type_literal(&literal) {
                            found.insert(literal);
                        }
                    }
                }
            }
            // Loop tables: `for request_type in [ "a.b", ... ]`.
            for remainder in source.split("for request_type in").skip(1) {
                let Some(open) = remainder.find('[') else {
                    continue;
                };
                let Some(close) = remainder[open..].find(']') else {
                    continue;
                };
                for literal in all_string_literals(&remainder[open..open + close]) {
                    if is_request_type_literal(&literal) {
                        found.insert(literal);
                    }
                }
            }
        }
    }
    found
}

fn first_string_literal(text: &str) -> Option<String> {
    let open = text.find('"')?;
    let tail = &text[open + 1..];
    let close = tail.find('"')?;
    Some(tail[..close].to_string())
}

fn all_string_literals(text: &str) -> Vec<String> {
    let mut literals = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        let tail = &rest[open + 1..];
        match tail.find('"') {
            Some(close) => {
                literals.push(tail[..close].to_string());
                rest = &tail[close + 1..];
            }
            None => break,
        }
    }
    literals
}

/// Kernel-bound REPL globals installed by `prime-agent-runtime` and checked
/// alongside `build_rlm_bootstrap_code`.
fn kernel_bound_names() -> BTreeSet<String> {
    let probe_skill = pa_core::kernel::bootstrap::PreparedJavaScriptSkill {
        name: "edit".to_string(),
        global_name: "edit".to_string(),
        entry_path: std::path::PathBuf::from("/skills/edit/src/index.ts"),
        package_path: std::path::PathBuf::from("/skills/edit"),
        package_json_path: std::path::PathBuf::from("/skills/edit/package.json"),
        unavailable_reason: None,
    };
    let code = pa_core::kernel::bootstrap::build_rlm_bootstrap_code(&[probe_skill], true);
    assert!(
        code.contains("__primeLoadSkills"),
        "bootstrap code must invoke __primeLoadSkills"
    );
    assert!(
        code.contains("__primeSetCompletionNoticesWired"),
        "bootstrap code must wire completion notices"
    );
    ["rlm", "bash", "sh", "mcp", "installPackage"]
        .into_iter()
        .map(String::from)
        .collect()
}

/// Bundled skills that are auth-gated builtin MCP integrations: they are disabled in sessions whose
/// user is not logged into the integration, so the prompt documents them only through the dynamic
/// skills inventory (and its generic "additional skills may exist" note), not as API surface.
fn auth_gated_bundled_skills() -> BTreeSet<String> {
    pa_core::mcp::BUILTIN_MCP_CATALOG
        .iter()
        .map(|(server, _, _)| server.to_string())
        .collect()
}

/// Conditionally-available bundled skills: the websearch skill rides with its
/// credential (an unset `bundledSkills.websearch` resolves with the selected
/// provider's stored or ambient key), so keyless installs exclude it — it must never be
/// documented as static core-tool surface; the dynamic skills inventory
/// renders it only on installs where it resolves enabled.
fn settings_gated_bundled_skills() -> BTreeSet<String> {
    ["websearch".to_string()].into_iter().collect()
}

/// Global names for every bundled JavaScript skill that is always available
/// (auth-gated integrations and the conditionally-available websearch skill excluded).
fn bundled_javascript_skills() -> Vec<String> {
    let gated = auth_gated_bundled_skills();
    let settings_gated = settings_gated_bundled_skills();
    sorted_bundled_skills()
        .into_iter()
        .filter(|skill| {
            skill
                .javascript
                .as_ref()
                .is_none_or(|js| !gated.contains(&js.global_name))
        })
        .filter(|skill| !settings_gated.contains(&skill.name))
        .filter_map(|skill| skill.javascript.map(|js| js.global_name))
        .collect()
}

/// The surface tokens the prompt is allowed to document: kernel-bound names, registered host
/// requests, bundled JavaScript skills, and the runtime-package (harness + generic MCP) API.
fn allowed_surface_tokens() -> BTreeSet<String> {
    let mut allowed = BTreeSet::new();
    allowed.extend(kernel_bound_names());
    for request in registered_host_requests() {
        if let Some(token) = prompt_token_for_host_request(&request) {
            allowed.insert(token);
        }
    }
    for global in bundled_javascript_skills() {
        allowed.insert(global);
    }
    for token in KERNEL_LOCAL_TOKENS.iter().chain(HARNESS_TOKENS) {
        allowed.insert(token.to_string());
    }
    allowed
}

/// The surface tokens the prompt MUST document.
fn required_surface_tokens() -> BTreeSet<String> {
    let mut required = BTreeSet::new();
    for request in registered_host_requests() {
        if let Some(token) = prompt_token_for_host_request(&request) {
            required.insert(token);
        }
    }
    for global in bundled_javascript_skills() {
        required.insert(global);
    }
    for token in KERNEL_LOCAL_TOKENS.iter().chain(HARNESS_TOKENS) {
        required.insert(token.to_string());
    }
    required
}

/// Surface tokens documented in the core layer: bullet entries whose first
/// backtick token is a lowercase-starting camelCase or dotted identifier.
fn documented_surface_tokens() -> BTreeSet<String> {
    let mut documented = BTreeSet::new();
    for line in CORE_LAYER.lines() {
        let Some(rest) = line.trim_start().strip_prefix("- `") else {
            continue;
        };
        let Some(end) = rest.find('`') else {
            continue;
        };
        let token = rest[..end].split('(').next().unwrap_or_default().trim();
        let valid = token
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase())
            && token
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')
            && !token.is_empty();
        if valid {
            documented.insert(token.to_string());
        }
    }
    documented
}

#[test]
fn core_layer_documents_the_real_tool_surface() {
    let documented = documented_surface_tokens();
    let allowed = allowed_surface_tokens();
    let required = required_surface_tokens();

    assert!(
        !required.is_empty() && !documented.is_empty(),
        "surface extraction produced nothing; the guard would be vacuous"
    );

    for token in &documented {
        let root = token.split('.').next().expect("non-empty token");
        let known = allowed.contains(token)
            || allowed.contains(root)
            || allowed
                .iter()
                .any(|candidate| candidate.starts_with(&format!("{root}.")));
        assert!(
            known,
            "prompt documents unknown tool {token:?}: a tool-surface change must \
             update prompts/layers/core.md (and this test's token mapping)"
        );
    }

    for token in &required {
        let documented_form = documented.contains(token)
            || documented
                .iter()
                .any(|entry| entry.starts_with(&format!("{token}.")))
            || documented
                .iter()
                .any(|entry| entry.starts_with(token.as_str()) && entry.contains('.'));
        assert!(
            documented_form,
            "tool {token:?} is on the registered surface but the prompt does not \
             document it: update prompts/layers/core.md"
        );
    }
}

// Packaged-set discovery

/// Every shipped skill directory is discoverable: the bundled `skills/` tree
/// loads name-for-name through the real discovery path, so a broken SKILL.md
/// (frontmatter that fails to parse, an empty description) fails here instead
/// of silently vanishing from the prompt and `/skill:<name>` lookup.
#[test]
fn every_shipped_skill_is_discoverable() {
    let skills_dir = bundled_skills_dir();
    let mut shipped: Vec<String> = std::fs::read_dir(&skills_dir)
        .expect("bundled skills directory")
        .filter_map(|entry| {
            let entry = entry.expect("skill dir entry");
            (entry.path().join("SKILL.md").is_file())
                .then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect();
    shipped.sort_unstable();
    assert!(
        !shipped.is_empty(),
        "the bundled skills directory must ship skills"
    );

    let skills = sorted_bundled_skills();
    let loaded: Vec<String> = skills.iter().map(|skill| skill.name.clone()).collect();
    assert_eq!(
        loaded, shipped,
        "every shipped skill directory must be discoverable"
    );
    for skill in &skills {
        assert_eq!(
            skill.file_path,
            skills_dir.join(&skill.name).join("SKILL.md"),
            "skill {} must load from its shipped directory",
            skill.name
        );
    }

    let mcp_skill = skills
        .iter()
        .find(|skill| skill.name == "mcp")
        .expect("the generic mcp skill is packaged");
    assert!(
        mcp_skill.javascript.is_none(),
        "the mcp skill is documentation for the pre-loaded runtime module, not a JavaScript package"
    );
}

/// The bounded-await contract renders wherever the JavaScript REPL does: every session kind, daemon
/// or daemonless, registers the bash completion notice the degrade relies on.
#[test]
fn bounded_await_contract_renders_in_daemon_and_daemonless_sessions() {
    let mut options = BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        messages_path: Some("/log.jsonl".to_string()),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["javascript"]),
        ..Default::default()
    };
    for daemonless in [false, true] {
        options.daemonless = daemonless;
        let prompt = system_prompt_breakdown(&options).assembled;
        assert!(
            prompt.contains("`r.running` is `true`")
                && prompt.contains("`r.exitCode` is `null`"),
            "daemonless={daemonless}: the prompt must carry the bounded-await result contract: {prompt}"
        );
    }
}

/// The generic mcp skill loads through the normal markdown discovery and renders in the
/// `<available_skills>` inventory exactly like any other markdown skill: without a `javascript_global` line.
#[test]
fn generic_mcp_skill_renders_in_the_prompt_inventory() {
    let mut options = BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        messages_path: Some("/log.jsonl".to_string()),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["javascript"]),
        ..Default::default()
    };
    let breakdown = system_prompt_breakdown(&options);
    let inventory = breakdown
        .segments
        .iter()
        .find(|segment| {
            matches!(segment.kind, SegmentKind::Dynamic)
                && segment.text.contains("<available_skills>")
        })
        .map(|segment| segment.text.clone())
        .expect("the skills inventory segment renders");
    assert!(inventory.contains("<name>mcp</name>"));
    assert!(inventory.contains("<type>markdown</type>"));
    let mcp_block_start = inventory
        .find("<name>mcp</name>")
        .expect("the mcp skill block");
    let mcp_block_end = inventory[mcp_block_start..]
        .find("</skill>")
        .map_or(inventory.len(), |end| mcp_block_start + end);
    let mcp_block = &inventory[mcp_block_start..mcp_block_end];
    assert!(
        !mcp_block.contains("javascript_global"),
        "a markdown skill never carries a javascript_global line"
    );
    options.generic_mcp_servers = vec!["notion".into()];
    let second = system_prompt_breakdown(&options);
    assert!(second.assembled.contains("await mcp.listTools(\"notion\")"));
}

// Async turn discipline

/// Since #3580 every session kind wakes on bash completion: daemonless runs
/// get a queued `[bash-done]` turn, so the static usage layer must not carry
/// the pre-#3580 rule to await commands before ending the turn — the
/// no-polling rule right below it already ends turns on the done
/// notification, and an unscoped await rule would contradict that wake.
#[test]
fn usage_layer_ends_turns_on_the_done_notification_not_an_await_rule() {
    assert!(
        !USAGE_LAYER.contains("await commands before ending the turn"),
        "every session kind has completion notifications: the await-before-turn-end rule is stale"
    );
    assert!(
        USAGE_LAYER.contains("end the turn and collect the result on the done notification"),
        "the no-polling rule keeps the collect-on-notice turn-end contract"
    );
}
