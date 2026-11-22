//! Golden preview cases matching the TypeScript `code-preview.ts` rules.

use super::{preview_bash_command, preview_javascript_code, CodePreviewLanguage};

#[test]
fn golden_previews_match_ts() {
    let corpus_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/preview.json");
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(corpus_path).expect("corpus file"))
            .expect("corpus JSON");
    let language = |preview: CodePreviewLanguage| match preview {
        CodePreviewLanguage::Bash => "bash",
        CodePreviewLanguage::JavaScript => "javascript",
    };
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let input = case["input"].as_str().expect("input");
        let preview = preview_bash_command(input);
        let actual = serde_json::json!({
            "language": language(preview.language),
            "text": preview.text,
        });
        assert_eq!(actual, case["bash"], "bash preview for {input:?}");
        let preview = preview_javascript_code(input);
        let actual = serde_json::json!({
            "language": language(preview.language),
            "text": preview.text,
        });
        assert_eq!(
            actual, case["javascript"],
            "javascript preview for {input:?}"
        );
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}
