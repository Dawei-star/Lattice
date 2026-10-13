//! Vault 文件监听（升级计划 P1-03 watcher 收敛）。
//!
//! 外部编辑器（Obsidian/VSCode）直接改动 Vault 文件时：
//! notify 事件 → 500ms 防抖合并 → 入队 `vault-scan` 任务（幂等 key）→
//! 发射 `vault://changed` Tauri 事件。真正对齐由 worker 执行
//! `Index::scan` 完成（增量 reconcile，未变化文件不读盘）。

use crate::jobs::JobsQueue;
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event};
use serde_json::json;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 防抖窗口：外部编辑器保存常触发多轮事件，合并为一轮扫描。
pub const DEBOUNCE: Duration = Duration::from_millis(500);

/// 扫描任务的幂等 key：同一时间只排队一个扫描，连发变更合并。
pub const SCAN_JOB_KEY: &str = "watcher-reconcile";

/// 事件防抖器（纯逻辑，可测试）：路径变更到达后标记脏，窗口满触发。
pub struct Debouncer {
    window: Duration,
    dirty_since: Option<Instant>,
}

impl Debouncer {
    pub fn new(window: Duration) -> Self {
        Self { window, dirty_since: None }
    }

    /// 记录一次文件变更；返回是否需要重置等待计时（首次变脏）。
    pub fn mark_dirty(&mut self, now: Instant) -> bool {
        let first = self.dirty_since.is_none();
        if first {
            self.dirty_since = Some(now);
        }
        first
    }

    /// 窗口已满则触发并复位；返回本轮是否触发了扫描。
    pub fn poll(&mut self, now: Instant) -> bool {
        match self.dirty_since {
            Some(since) if now.duration_since(since) >= self.window => {
                self.dirty_since = None;
                true
            }
            _ => false,
        }
    }
}

/// 启动监听：阻塞运行在调用者给的线程里（setup 中 spawn 专属线程）。
/// `on_reconcile` 在每轮防抖触发时被调用（入队扫描任务 / 发射事件）。
pub fn spawn_watcher<F: Fn() + Send + 'static>(
    root: &Path,
    on_reconcile: F,
) -> notify::Result<()> {
    let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |result| {
            let _ = sender.send(result);
        })?;
    watcher.watch(root, RecursiveMode::Recursive)?;

    let mut debouncer = Debouncer::new(DEBOUNCE);
    loop {
        // 事件到达后等满防抖窗口再触发，窗口内新事件只刷新不重置计时
        match receiver.recv() {
            Ok(_) => {
                if debouncer.mark_dirty(Instant::now()) {
                    let deadline = Instant::now() + DEBOUNCE;
                    while Instant::now() < deadline {
                        let _ = receiver.recv_timeout(deadline - Instant::now());
                    }
                }
                if debouncer.poll(Instant::now()) {
                    on_reconcile();
                }
            }
            Err(error) => {
                log::warn!("watcher 通道断开，监听退出：{error}");
                return Ok(());
            }
        }
    }
}

/// 把一轮变更转成扫描任务并入队（watcher 与测试共用）。
pub fn enqueue_reconcile(queue: &JobsQueue) -> Result<String, String> {
    let job = queue.enqueue("vault-scan", Some(SCAN_JOB_KEY), &json!({"trigger": "watcher"}))?;
    Ok(job.id)
}

#[cfg(test)]
mod tests {
    use super::{Debouncer, DEBOUNCE};
    use std::time::{Duration, Instant};

    #[test]
    fn debounce_merges_bursts_and_fires_once_per_window() {
        let mut debouncer = Debouncer::new(DEBOUNCE);
        let t0 = Instant::now();
        assert!(debouncer.mark_dirty(t0), "首次变脏");
        assert!(!debouncer.mark_dirty(t0 + Duration::from_millis(50)));
        assert!(!debouncer.poll(t0 + Duration::from_millis(200)), "窗口未满不触发");
        assert!(debouncer.poll(t0 + DEBOUNCE), "窗口满触发");
        assert!(!debouncer.poll(t0 + DEBOUNCE), "触发后复位");
        assert!(!debouncer.poll(t0 + DEBOUNCE + DEBOUNCE), "无新变更不再触发");
    }

    #[test]
    fn new_burst_after_fire_starts_new_window() {
        let mut debouncer = Debouncer::new(DEBOUNCE);
        let t0 = Instant::now();
        debouncer.mark_dirty(t0);
        assert!(debouncer.poll(t0 + DEBOUNCE));
        debouncer.mark_dirty(t0 + DEBOUNCE + Duration::from_millis(10));
        assert!(!debouncer.poll(t0 + DEBOUNCE + Duration::from_millis(100)));
        assert!(debouncer.poll(t0 + DEBOUNCE + Duration::from_millis(10) + DEBOUNCE));
    }
}
