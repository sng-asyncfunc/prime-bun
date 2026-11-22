//! Code-preview extraction for tool-call cards (`javascript` collapsed line).
//! The pa-tui dependency boundary (pa-types only) keeps the session engine
//! out of the UI, so the display-side preview algorithm lives here; the
//! TypeScript golden corpus test lives here too.

pub(crate) mod bash;
#[cfg(test)]
mod golden_tests;
mod javascript;

pub use bash::{preview_bash_command, CodePreview, CodePreviewLanguage};
pub use javascript::preview_javascript_code;
