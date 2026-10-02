/**
 * 工作区辅助接口。
 * POST /api/workspace/sse-ticket：用长期令牌换取 30 秒一次性票据，
 * 供 EventSource（无法带请求头）打开 SSE 事件流，避免长期令牌进 URL。
 */
import { Router } from 'express';
import { issueSseTicket } from './sse-tickets.js';

export const workspaceRouter = Router();

workspaceRouter.post('/sse-ticket', (_req, res) => {
  res.json({ data: issueSseTicket() });
});
