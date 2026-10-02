/**
 * SSE 事件流专用路由。
 *
 * 挂载在全局 authenticateWorkspace 之前：EventSource 无法携带自定义请求头，
 * 这里自行完成「标准令牌（头/Bearer）或一次性短时票据」二选一校验。
 * 配置了 WORKSPACE_ACCESS_TOKEN 且两者都无效时返回 401；
 * 未配置令牌（默认本机模式）时行为与之前完全一致。
 */
import { Router } from 'express';
import { config } from '../../config/index.js';
import { readBearerToken, sameSecret } from '../../middleware/workspaceAuth.js';
import { sseTicketStore } from '../workspace/sse-tickets.js';
import { streamEvents } from './vault.controller.js';

export const vaultEventsRouter = Router();

vaultEventsRouter.get('/api/vault/events', (req, res) => {
  if (!config.workspaceAccessToken) {
    streamEvents(req, res);
    return;
  }

  const headerToken = req.get('x-workspace-token')?.trim() || readBearerToken(req.get('authorization'));
  if (headerToken && sameSecret(headerToken, config.workspaceAccessToken)) {
    streamEvents(req, res);
    return;
  }

  const queryTicket = typeof req.query?.sseTicket === 'string' ? req.query.sseTicket : '';
  if (queryTicket) {
    for (const [candidate, entry] of sseTicketStore) {
      if (candidate === queryTicket && !entry.used && entry.expiresAt > Date.now()) {
        entry.used = true; // 一次性：命中即核销，防重放
        streamEvents(req, res);
        return;
      }
    }
  }

  res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: '工作区访问令牌缺失或无效',
      requestId: req.id ?? 'unknown',
    },
  });
});
