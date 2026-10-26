/**
 * AI 会话记录持久化回归测试（对应 issue：点击历史会话后回答记录消失）。
 *
 * 背景（2026-10 用户数据取证结论）：
 *  - 运行失败的回答只进临时错误横幅（setError），从不写进会话的本地持久化行；
 *    用户点开/切回会话后，会话里只剩自己的提问，看起来像"回答记录丢了"。
 *  - 修复后：失败（非中止）要落一条 assistant 失败记录进会话；成功/失败/中止
 *    在 stale（视图已切走）时也要写进发起请求的会话行，而不是丢记录或串会话。
 *
 * 三组用例：
 *  1. React 18 + jsdom 时序机制测试：会话切换后，App 回传 initialSessionId
 *     （onSessionChange 回声）触发的重置 effect 不得吞掉微任务里完成的本地恢复；
 *  2. 同机制的桌面端时序：本地恢复先完成、App 回声后到（Tauri IPC 拒绝快于
 *     tab 状态更新）时，回声同样不得清空已恢复的消息——线上"点哪个会话都停在
 *     欢迎页"的确定性复现；
 *  3. 源码接线断言：AIAssistantPanel 的失败/stale 分支必须持久化记录，且
 *     重置 effect 必须带回声防护。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, waitFor } from './dom-setup.mjs';

installDom();

const WELCOME = [{ id: 'ai-welcome', content: '欢迎' }];
const HISTORY_S1 = [{ id: 'm1', content: '非让我' }, { id: 'm2', content: '回答内容' }];

/** 复刻桌面端 sessionStore gateway.messages 的时序：/ai/sessions 无路由 → 微任务内 reject → 回退本地 */
async function loadMessages(id) {
  try {
    await Promise.resolve();
    await Promise.reject(new Error('桌面端暂未接入该能力'));
    return [];
  } catch {
    await Promise.resolve();
    return id === 'S1' ? HISTORY_S1 : [];
  }
}

function Panel({ initialSessionId, onSessionChange, loadMessages, onSelectRef }) {
  const [sessionId, setSessionId] = useState(() => (initialSessionId?.trim() ? initialSessionId : 'local-default'));
  const [messages, setMessages] = useState(WELCOME);
  const loadedSessionRef = useRef(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // AIAssistantPanel.tsx:817
  useEffect(() => {
    onSessionChange?.(sessionId);
  }, [onSessionChange, sessionId]);

  // AIAssistantPanel.tsx:849（修复：App 回传的 initialSessionId 与当前会话一致时是回声，
  // 不得重置——否则把刚恢复的消息清成欢迎页，且 setSessionId 同值跳出渲染，
  // 恢复 effect 不会重跑，会话从此停在欢迎页）
  useEffect(() => {
    if (initialSessionId?.trim() && initialSessionId.trim() === sessionIdRef.current) return;
    loadedSessionRef.current = null;
    setMessages(WELCOME);
    setSessionId(() => (initialSessionId?.trim() ? initialSessionId : 'local-default'));
  }, [initialSessionId]);

  // AIAssistantPanel.tsx:1026（修复：完成标记在恢复落地后写入，被打断的加载允许重试）
  useEffect(() => {
    if (loadedSessionRef.current === sessionId) return;
    let cancelled = false;
    (async () => {
      const restored = await loadMessages(sessionId);
      if (cancelled) return;
      loadedSessionRef.current = sessionId;
      setMessages((current) => (current.some((item) => item.id !== 'ai-welcome') ? current : (restored.length ? restored : WELCOME)));
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, loadMessages]);

  // selectSession（AIAssistantPanel.tsx:2452）的等价点击
  onSelectRef.current = (id) => {
    setSessionId(id);
    setMessages(WELCOME);
  };

  return React.createElement('div', { 'data-testid': 'state' }, JSON.stringify({ sessionId, messages }));
}

function App({ onSelectRef }) {
  const [tabSessionId, setTabSessionId] = useState('S0');
  // App.tsx:583 handleAiSessionChange：把面板上报的 sessionId 写回 tab（initialSessionId 的来源）
  const handleSessionChange = useCallback((id) => {
    setTabSessionId(id);
  }, []);
  return React.createElement(Panel, { initialSessionId: tabSessionId, onSessionChange: handleSessionChange, loadMessages, onSelectRef });
}

/** 桌面端真实时序：本地恢复（IPC 拒绝 → 本地回退，微任务级）先完成，App 的
 * tab 状态更新后到。用宏任务推迟回声，确定性复现"回声晚到"这条竞态。 */
function DelayedEchoApp({ onSelectRef, echoDelayMs = 30 }) {
  const [tabSessionId, setTabSessionId] = useState('S0');
  const handleSessionChange = useCallback((id) => {
    setTimeout(() => setTabSessionId(id), echoDelayMs);
  }, [echoDelayMs]);
  return React.createElement(Panel, { initialSessionId: tabSessionId, onSessionChange: handleSessionChange, loadMessages, onSelectRef });
}

function readMountedState() {
  const node = document.querySelector('[data-testid=state]');
  return node ? JSON.parse(node.textContent) : null;
}

test('机制：点击历史会话后，App 的 sessionId 回声不得清空刚恢复的消息记录', async () => {
  const onSelectRef = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(App, { onSelectRef }));

  const readState = readMountedState;

  // 初始：S0 无历史 → 欢迎态
  await waitFor(() => readState()?.sessionId === 'S0', { label: '初始渲染' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(readState().messages, WELCOME);

  // 点击历史会话 S1（selectSession）
  onSelectRef.current('S1');

  // 等所有 React 调度宏任务与微任务链沉淀
  await new Promise((resolve) => setTimeout(resolve, 120));
  const state = readState();
  assert.equal(state.sessionId, 'S1');
  assert.deepEqual(
    state.messages,
    HISTORY_S1,
    `点击历史会话后消息被清空：${JSON.stringify(state.messages)}`,
  );

  root.unmount();
  container.remove();
});

test('机制：回声晚于本地恢复到达（桌面端时序）也不得清空已恢复的消息', async () => {
  const onSelectRef = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(DelayedEchoApp, { onSelectRef }));

  const readState = readMountedState;

  await waitFor(() => readState()?.sessionId === 'S0', { label: '初始渲染' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(readState().messages, WELCOME);

  // 点击历史会话 S1：本地恢复微任务内完成，30ms 后 App 回声才到。
  // 修复前：回声触发重置 effect 清成欢迎页，且同值 setSessionId 不再触发
  // 恢复重跑——正是"点哪个会话都停在欢迎页"的线上表现。
  onSelectRef.current('S1');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = readState();
  assert.equal(state.sessionId, 'S1');
  assert.deepEqual(
    state.messages,
    HISTORY_S1,
    `回声后到仍清空了已恢复的消息：${JSON.stringify(state.messages)}`,
  );

  root.unmount();
  container.remove();
});

test('接线：运行失败必须持久化进会话记录，stale 分支不得丢记录或串会话', async () => {
  const source = await fs.readFile(new URL('../src/components/AIAssistantPanel.tsx', import.meta.url), 'utf8');

  // 1. 失败（非中止）分支：错误横幅之外，还要 appendMessage 落失败记录
  assert.match(
    source,
    /assistant-failed-[\s\S]{0,240}role: 'assistant'[\s\S]{0,240}completionStatus: 'failed'/,
    '失败分支没有把失败记录落成 assistant 消息',
  );

  // 2. stale（视图已切走）时：成功回答写进发起请求的会话行，而不是当前会话
  assert.match(
    source,
    /if \(stale\(\)\) persistSessionRecord\(requestSessionId, assistant\);\s*else appendMessage\(assistant\);/,
    '成功回答的 stale 分支没有写回原会话（会串会话/丢记录）',
  );

  // 3. stale 时中止与失败也分别落原会话
  const stalePersistCount = (source.match(/persistSessionRecord\(requestSessionId,/g) ?? []).length;
  assert.ok(stalePersistCount >= 3, `stale 分支的持久化调用不足（found ${stalePersistCount}，need >=3）`);

  // 4. persistSessionRecord：写目标会话行，找不到行时不误写当前会话
  assert.match(
    source,
    /const persistSessionRecord = useCallback\(\(targetSessionId: string, message: AiMessage\)/,
    '缺少跨会话持久化辅助函数 persistSessionRecord',
  );
  assert.match(
    source,
    /persistSessionRecord[\s\S]{0,900}if \(!existing\) return;/,
    'persistSessionRecord 必须在目标会话行不存在时直接返回（不得新建/误写）',
  );

  // 5. 回声防护：App 把面板自己上报的 sessionId 原样传回时，重置 effect 必须
  //    跳过，否则刚恢复的消息被清成欢迎页且不会重跑恢复（线上"点哪个会话都空"）
  assert.match(
    source,
    /initialSessionId\.trim\(\) === sessionIdRef\.current/,
    '重置 effect 缺少回声防护（initialSessionId 与当前会话一致时不得重置）',
  );

  // 6. 恢复完成标记必须在消息落地后写入：发起时标记会让被依赖变化打断的加载
  //    在重跑时被引用守卫挡死，视图停在欢迎页
  assert.match(
    source,
    /await sessionStore\.select\(sessionId\);\s*\n\s*if \(cancelled\) return;\s*\n\s*loadedSessionRef\.current = sessionId;/,
    '恢复 effect 的完成标记应在 sessionStore.select 成功返回后再写入',
  );

  console.log('AI session persistence regression tests passed');
});
