/**
 * SSE 一次性短时票据存储。
 *
 * EventSource 无法携带自定义请求头，配置了 WORKSPACE_ACCESS_TOKEN 时，
 * 此前只能把长期令牌放进 URL 查询串（会进入浏览器历史与代理日志）。
 * 浏览器先 POST /api/workspace/sse-ticket 换取 30 秒一次性票据，
 * 再用 ?sseTicket= 打开事件流。
 *
 * 值对象带 used 标记做核销：来自请求的票据字符串只参与等值比较，
 * 不作为 Map.get/delete 的键参（一次性语义由 entry.used 保证）。
 */
import { randomBytes } from 'node:crypto';

const TICKET_TTL_MS = 30_000;
const PRUNE_THRESHOLD = 64;

/** ticket（服务端自签）→ { expiresAt, used } */
export const sseTicketStore = new Map();

export function issueSseTicket() {
  const now = Date.now();
  if (sseTicketStore.size >= PRUNE_THRESHOLD) {
    for (const [ticket, entry] of sseTicketStore) {
      if (entry.used || entry.expiresAt <= now) sseTicketStore.delete(ticket);
    }
  }
  const ticket = randomBytes(24).toString('base64url');
  sseTicketStore.set(ticket, { expiresAt: now + TICKET_TTL_MS, used: false });
  return { ticket, expiresInMs: TICKET_TTL_MS };
}
