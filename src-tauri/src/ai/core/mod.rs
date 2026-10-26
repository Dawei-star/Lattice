//! AI 内核目录门面。各子模块的职责与接口约定见地基方案 §5；模块文档为唯一权威。

pub(crate) mod agent;
pub(crate) mod config;
pub(crate) mod context;
pub(crate) mod expert;
pub(crate) mod prompt;
pub(crate) mod provider;
pub(crate) mod trace;
