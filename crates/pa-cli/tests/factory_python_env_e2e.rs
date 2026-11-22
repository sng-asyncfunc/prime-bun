//! The CLI's direct Bun dispatch must use the same project startup boundary
//! as kernel probes and the persistent REPL.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[test]
fn factory_dispatch_and_probes_drop_project_bun_preload_env() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let trusted = root.path().join("trusted");
    let kernel_dir = root.path().join("kernel-bun");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&trusted).unwrap();
    std::fs::create_dir_all(kernel_dir.join("src")).unwrap();
    std::fs::write(
        kernel_dir.join("package.json"),
        r#"{"name":"prime-agent-runtime"}"#,
    )
    .unwrap();
    std::fs::write(kernel_dir.join("src/repl.ts"), "// stub\n").unwrap();
    std::fs::write(kernel_dir.join("src/factory-cli.ts"), "// stub\n").unwrap();

    let bun = root.path().join("fake-bun");
    std::fs::write(
        &bun,
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.3.14\n'
  exit 0
fi
[ -z "${NODE_OPTIONS+x}" ] || exit 42
[ -z "${NODE_PATH+x}" ] || exit 43
[ -z "${BUN_PRELOAD+x}" ] || exit 44
case "$*" in
  *factory-cli.ts*)
    touch "$DISPATCH_MARKER"
    printf '%s\n' '{"ok":true,"machines":[]}'
    ;;
  *)
    exit 0
    ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o755)).unwrap();
    let marker = root.path().join("factory-dispatched");
    let path = std::env::join_paths([Path::new("."), &project, &trusted]).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["factory", "list", "--json"])
        .current_dir(&project)
        .env("PRIME_AGENT_KERNEL_BUN", &bun)
        .env("PRIME_AGENT_KERNEL_BUN_DIR", &kernel_dir)
        .env("NODE_OPTIONS", "--require=./evil.js")
        .env("NODE_PATH", path)
        .env("BUN_PRELOAD", "./evil.ts")
        .env("DISPATCH_MARKER", &marker)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.exists(), "the factory dispatch never reached Bun");
}

#[test]
fn missing_home_reports_agent_directory_requirement_without_a_panic() {
    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("config")
        .env_remove("HOME")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("HOME or PRIME_AGENT_CODING_AGENT_DIR is required"),
        "unexpected stderr: {stderr}"
    );
    assert!(!stderr.contains("panicked"), "unexpected panic: {stderr}");

    let help = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("--help")
        .env_remove("HOME")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .output()
        .unwrap();
    assert!(help.status.success(), "help should not require a home");

    for args in [["help", "package"], ["package", "--help"]] {
        let help = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
            .args(args)
            .env_remove("HOME")
            .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
            .output()
            .unwrap();
        assert!(
            help.status.success(),
            "{args:?} should show help without a home: {}",
            String::from_utf8_lossy(&help.stderr)
        );
    }

    let package = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["package", "list"])
        .env_remove("HOME")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .output()
        .unwrap();
    assert_eq!(package.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&package.stderr)
        .contains("HOME or PRIME_AGENT_CODING_AGENT_DIR is required"));
}
