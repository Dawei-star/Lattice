import type { ToastApi } from '../hooks/useToast.tsx';

export type AiRunNotificationStatus = 'completed' | 'failed';

export interface AiRunNotificationInput {
  runId: string;
  status: AiRunNotificationStatus;
  panelVisible: boolean;
  error?: string;
  toast: Pick<ToastApi, 'success' | 'error'>;
  notifiedRunIds: Set<string>;
  systemNotify?: (title: string, options: { body: string; tag: string }) => void;
}

function defaultSystemNotify(title: string, options: { body: string; tag: string }) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification(title, options);
}

/** Notify only once per durable run, and stay quiet while the AI panel is visible. */
export function notifyAiRunCompletion(input: AiRunNotificationInput): boolean {
  if (!input.runId || input.notifiedRunIds.has(input.runId)) return false;
  input.notifiedRunIds.add(input.runId);

  if (input.panelVisible) return false;

  const failed = input.status === 'failed';
  const title = failed ? 'AI 任务失败' : 'AI 任务已完成';
  const body = failed
    ? (input.error?.trim() || '后台任务执行失败，请返回查看详情。')
    : '后台运行已完成，可返回 AI 面板查看结果。';
  const dedupeKey = `ai-run:${input.runId}:${input.status}`;
  if (failed) input.toast.error(title, { detail: body, dedupeKey });
  else input.toast.success(title, { detail: body, dedupeKey });

  try {
    (input.systemNotify ?? defaultSystemNotify)(title, { body, tag: dedupeKey });
  } catch {
    // System notifications are optional and must not affect the completed run.
  }
  return true;
}
