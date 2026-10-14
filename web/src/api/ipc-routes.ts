/**
 * 「HTTP 路由 → Tauri 命令」映射表。
 *
 * 维护约定：
 *  1. **排序**：同一 method 下，静态路径必须先于「会吞掉它的」动态路径注册
 *     （如 `/experts/skills` 先于 `/experts/:id`），因为 `matchIpcRoute` 按注册顺序取首个命中。
 *  2. **只放真实可对齐的路由**：Rust 命令不存在（契约里 ⬜ 的 10 个非 AI 命令）、
 *     或入参/返回结构与前端消费方对不上的，一律不写进本表——写进去会在桌面形态下
 *     静默改变行为。排除项与证据见文件末尾「排除清单」，作为 P1-08 的核销议程。
 *  3. **参数名**：Tauri 2 默认把 JS 的 camelCase key 映射到 Rust 的 snake_case 形参，
 *     59 个命令均未使用 `rename_all`，所以这里一律写 camelCase。
 *     参数只写 Rust 签名里真实存在的键，绝不携带多余键。
 *  4. **不做网络语义**：无需处理超时/重试/离线，见 ipc.ts 模块注释。
 *  5. 每条自定义 args/envelope 的路由都写 `note`，说明适配点，便于契约核对。
 */
import type { IpcCallContext, IpcRoute } from './ipc.ts';

type Args = Record<string, unknown>;

/** 必填字符串（缺值 → 由调用方回落 HTTP） */
const asString = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
/** 可空字符串：空串归一为 null，避免 Rust 侧 `Some("")` 被当成有效值 */
const optionalString = (value: unknown): string | null =>
  value === undefined || value === null || value === '' ? null : String(value);
/** 可空数字：非法值归一为 null，而不是把 NaN 递过线缆 */
const optionalNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};
/** 布尔：只认真值 true / 'true' */
const flag = (value: unknown): boolean => value === true || value === 'true';
/** 取对象型 body（非对象一律视为空） */
const obj = (ctx: IpcCallContext): Args =>
  ctx.body && typeof ctx.body === 'object' ? (ctx.body as Args) : {};

export const IPC_ROUTES: readonly IpcRoute[] = [
  // ---------------------------------------------------------------- GET
  // 静态路径优先（见约定 1）
  { method: 'GET', path: '/vault/attachments/references', command: 'vault_attachment_references',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      return path ? { path } : undefined;
    } },
  { method: 'GET', path: '/vault/attachments', command: 'vault_attachments_list' },
  { method: 'GET', path: '/vault/files', command: 'vault_files_list' },
  { method: 'GET', path: '/tags', command: 'tag_list' },
  { method: 'GET', path: '/graph', command: 'graph_build' },
  { method: 'GET', path: '/meta/overview', command: 'meta_overview' },
  // note_index 于 P1-08 第 2 步回收：Rust 侧补上 `properties` 对象后与 Express 结构完全对齐
  // （`npm run test:desktop` 的 parity 测试确认 `note_index` 已不在差异清单内）
  { method: 'GET', path: '/notes/index', command: 'note_index' },
  // canvas_list 于 P1-08 第 2 步回收：Rust 改为返回 `{path,name,folderPath}` 对象数组后对齐
  { method: 'GET', path: '/canvas/files', command: 'canvas_list' },
  { method: 'GET', path: '/folders', command: 'folder_tree' },
  { method: 'GET', path: '/canvas', command: 'canvas_read',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      return path ? { path } : undefined;
    } },
  { method: 'GET', path: '/files/log', command: 'file_log',
    args: (ctx) => ({ limit: optionalNumber(ctx.query.limit) }) },
  { method: 'GET', path: '/experts/skills', command: 'skill_list' },
  { method: 'GET', path: '/experts', command: 'expert_list' },
  { method: 'GET', path: '/review/health', command: 'review_health',
    args: (ctx) => ({
      staleDays: optionalNumber(ctx.query.staleDays),
      limit: optionalNumber(ctx.query.limit),
    }) },
  // 动态路径
  { method: 'GET', path: /^\/experts\/skills\/(?<id>[^/]+)$/, command: 'skill_get',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },
  { method: 'GET', path: /^\/experts\/(?<id>[^/]+)$/, command: 'expert_get',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },

  // --------------------------------------------------------------- POST
  { method: 'POST', path: '/vault/attachments/validate', command: 'vault_attachment_validate',
    args: (ctx) => {
      const body = obj(ctx);
      return { content: asString(body.content), filePath: optionalString(body.filePath) };
    } },
  { method: 'POST', path: '/vault/attachments/cleanup', command: 'vault_attachment_cleanup',
    // Rust 的 dryRun 默认 true，必须显式回传，否则 dryRun=false 的清理会被当成预演
    args: (ctx) => {
      const body = obj(ctx);
      return {
        dryRun: body.dryRun === undefined ? null : flag(body.dryRun),
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    },
    note: 'dryRun 显式回传：Rust 默认 true，前端 schema 默认 false' },
  { method: 'POST', path: '/files/preview', command: 'file_preview',
    args: (ctx) => {
      const body = obj(ctx);
      if (Array.isArray(body.actions)) return { actions: body.actions };
      if (Object.keys(body).length === 0) return undefined;
      return { action: ctx.body };
    },
    note: '命令形参是 action/actions 二态；前端传单个 FileAction' },
  { method: 'POST', path: '/files/execute', command: 'file_execute',
    args: (ctx) => {
      const body = obj(ctx);
      const confirmation = {
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
        planId: optionalString(body.planId),
        planHash: optionalString(body.planHash),
      };
      if (Array.isArray(body.actions)) return { actions: body.actions, ...confirmation };
      if (Object.keys(body).length === 0) return undefined;
      return { action: ctx.body, ...confirmation };
    },
    note: '命令形参是 action/actions 二态；前端传单个 FileAction' },
  { method: 'POST', path: '/files/undo', command: 'file_undo',
    args: (ctx) => {
      const body = obj(ctx);
      return { operationId: optionalString(body.operationId), force: flag(body.force) };
    } },
  { method: 'POST', path: '/experts/route', command: 'expert_route',
    args: (ctx) => {
      const body = obj(ctx);
      return { message: asString(body.message), excludeId: optionalString(body.excludeId) };
    } },
  { method: 'POST', path: '/experts/skills', command: 'skill_save',
    args: (ctx) => ({ skill: ctx.body, confirmed: flag(obj(ctx).confirmed) }),
    note: '整体载荷作为 skill 传入；confirmed 由 Rust 白名单化，不会落盘' },
  { method: 'POST', path: '/experts', command: 'expert_save',
    args: (ctx) => ({ expert: ctx.body, confirmed: flag(obj(ctx).confirmed) }),
    note: '整体载荷作为 expert 传入；confirmed 由 Rust 白名单化，不会落盘' },
  { method: 'POST', path: '/review/health/plan', command: 'review_plan',
    args: (ctx) => {
      const body = obj(ctx);
      if (!Array.isArray(body.findingIds)) return undefined;
      return {
        findingIds: body.findingIds.map(asString),
        staleDays: optionalNumber(body.staleDays),
        limit: optionalNumber(body.limit),
      };
    },
    note: 'findingIds 为必填形参，缺失则回落 HTTP' },
  { method: 'POST', path: '/review/health/execute', command: 'review_execute',
    args: (ctx) => {
      const body = obj(ctx);
      const planId = optionalString(body.planId);
      const planHash = optionalString(body.planHash);
      if (!planId || !planHash) return undefined;
      return {
        planId,
        planHash,
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    },
    note: 'planId/planHash 为必填形参，缺失则回落 HTTP' },
  // 动态路径
  { method: 'POST', path: /^\/notes\/(?<id>[^/]+)\/history\/(?<version>[^/]+)\/restore$/, command: 'note_history_restore',
    args: (ctx) => {
      const body = obj(ctx);
      return {
        id: asString(ctx.params.id),
        version: asString(ctx.params.version),
        expectedCurrentHash: optionalString(body.expectedCurrentHash),
        confirmed: flag(body.confirmed),
      };
    },
    note: 'body 为空串的 expectedCurrentHash 必须归一为 null，否则 Rust 会误判 CONFLICT' },

  // ---------------------------------------------------------------- PUT
  { method: 'PUT', path: '/canvas', command: 'canvas_write',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      if (!path) return undefined;
      const body = obj(ctx);
      return {
        path,
        nodes: body.nodes ?? [],
        edges: body.edges ?? [],
        expectedHash: optionalString(body.expectedHash),
        confirmed: flag(body.confirmed),
      };
    },
    note: 'body 是整个 CanvasDocument，需拆成 nodes/edges 两个形参' },
  { method: 'PUT', path: /^\/experts\/skills\/(?<id>[^/]+)$/, command: 'skill_save',
    args: (ctx) => ({
      skill: ctx.body,
      id: asString(ctx.params.id),
      confirmed: flag(obj(ctx).confirmed),
    }) },
  { method: 'PUT', path: /^\/experts\/(?<id>[^/]+)$/, command: 'expert_save',
    args: (ctx) => ({
      expert: ctx.body,
      id: asString(ctx.params.id),
      confirmed: flag(obj(ctx).confirmed),
    }) },

  // -------------------------------------------------------------- PATCH
  { method: 'PATCH', path: '/canvas/file', command: 'canvas_move',
    args: (ctx) => {
      const body = obj(ctx);
      const fromPath = optionalString(body.fromPath);
      const toPath = optionalString(body.toPath);
      if (!fromPath || !toPath) return undefined;
      return { fromPath, toPath, confirmed: flag(body.confirmed) };
    } },

  // ------------------------------------------------------------- DELETE
  { method: 'DELETE', path: '/vault/attachments', command: 'vault_attachment_delete',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      if (!path) return undefined;
      return {
        path,
        confirmed: flag(ctx.query.confirmed),
        secondConfirmed: flag(ctx.query.secondConfirmed),
      };
    } },
  { method: 'DELETE', path: '/canvas/file', command: 'canvas_delete',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      if (!path) return undefined;
      const body = obj(ctx);
      return {
        path,
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    },
    note: '确认参数在 body（canvas.ts:26），而不是 query' },
  { method: 'DELETE', path: /^\/experts\/skills\/(?<id>[^/]+)$/, command: 'skill_delete',
    args: (ctx) => {
      const body = obj(ctx);
      return {
        id: asString(ctx.params.id),
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    } },
  { method: 'DELETE', path: /^\/experts\/(?<id>[^/]+)$/, command: 'expert_delete',
    args: (ctx) => {
      const body = obj(ctx);
      return {
        id: asString(ctx.params.id),
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    } },
  { method: 'DELETE', path: /^\/notes\/(?<id>[^/]+)$/, command: 'note_delete',
    args: (ctx) => {
      const body = obj(ctx);
      return {
        id: asString(ctx.params.id),
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    } },
];

/**
 * 契约里仍是 ⬜、尚未实现为 Tauri 命令的非 AI 端点（对应下方排除清单 A）。
 *
 * 这些名字**不应**出现在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里。
 * 一旦有人实现了其中一个，`web/test/ipc-routes-contract.test.mjs` 会失败，提示把
 * 对应路由从排除清单移进 `IPC_ROUTES`——把「待办」变成可执行断言。
 */
export const IPC_PENDING_COMMANDS: readonly string[] = [
  'vault_profile_set',
  'vault_migrate_sqlite',
  'vault_assets_list',
  'note_list',
  'note_get',
  'note_duplicate',
  'note_templates_list',
  'note_create_from_template',
  'note_create_daily',
  'tag_delete',
];

/**
 * 已排除的路由（`METHOD /path`，动态段写 `:id` 形态）。
 *
 * 约束：**不得**同时出现在 `IPC_ROUTES` 中——进表项与排除项是互斥的，
 * 由 ipc-routes-contract 测试守住。排除理由见上方注释块 A/B 两节。
 */
export const IPC_EXCLUDED_ROUTES: readonly string[] = [
  // A. 缺命令（11）
  'PUT /vault/profile',
  'POST /vault/migrate',
  'GET /vault/assets',
  'GET /notes',
  'GET /notes/:id',
  'POST /notes/:id/duplicate',
  'GET /notes/templates',
  'POST /notes/from-template',
  'POST /notes/daily',
  'DELETE /tags/:id',
  'GET /health',
  // B. 结构不兼容（11）
  'GET /vault/info',
  'POST /vault/attachments',
  'GET /vault/download',
  'POST /notes',
  'PATCH /notes/:id',
  'GET /notes/:id/history',
  'GET /notes/:id/history/:version',
  'POST /folders',
  'PATCH /folders/:id',
  'DELETE /folders/:id',
  'GET /search',
];

/**
 * 排除清单（22 条，逐条经代码核对，供 P1-08 核销）。
 *
 * A. 缺命令（11 条）——契约里仍是 ⬜，Rust 侧没有对应命令：
 *    - PUT  /vault/profile                     → 待实现 vault_profile_set（SettingsModal）
 *    - POST /vault/migrate                     → 待实现 vault_migrate_sqlite（SettingsModal）
 *    - GET  /vault/assets                      → 待实现 vault_assets_list（CanvasView 资产面板）
 *    - GET  /notes                             → 待实现 note_list（前端靠 getFull 的 meta.total 分页）
 *    - GET  /notes/:id                         → 待实现 note_get
 *    - POST /notes/:id/duplicate               → 待实现 note_duplicate
 *    - GET  /notes/templates                   → 待实现 note_templates_list
 *    - POST /notes/from-template               → 待实现 note_create_from_template
 *    - POST /notes/daily                       → 待实现 note_create_daily
 *    - DELETE /tags/:id                        → 待实现 tag_delete
 *    - GET  /health                            → 契约 ⛔（桌面单机无探针需求），且前端无调用点
 *
 * B. 结构不兼容（11 条）——命令存在但对不上，需先改 Rust 或前端契约：
 *    - GET  /vault/info          : 命令只回 {path}，前端消费 vaultDir + profile（useVault.ts:280/281）
 *    - POST /vault/attachments   : 命令无 folder 形参（EditorPane 传 query.folder），且回裸 String
 *                                  路径而前端读 uploaded.path/name
 *    - GET  /vault/download      : 前端直接 fetch + blob()（不经 client），命令回 base64 JSON
 *    - POST /notes               : note_create 无 folderId 形参（resources.ts:143 恒发该键）
 *    - PATCH /notes/:id          : note_update 无 folderId 形参（saveNote/moveNote 都在传）
 *    - GET  /notes/:id/history   : 前端期望 {items,currentHash}，命令回 HistoryEntry 数组
 *    - GET  /notes/:id/history/:version : 前端期望 {version,createdAt,title,content,isPinned,properties}，
 *                                  命令只给 {version,raw,hash}
 *    - POST /folders             : 命令收父目录**路径** parent_path，前端传 parentId（useVault.ts:811）
 *    - PATCH /folders/:id        : 命令收 new_parent_path，前端 move 传 parentId（useVault.ts:833）；
 *                                  且命令回全树而前端类型是单节点
 *    - DELETE /folders/:id       : 前端读 result.affectedNoteCount，命令回全树无此字段；
 *                                  且 Rust 对非空目录 CONFLICT 拒绝，Express 是「笔记移到未分类」
 *    - GET  /search              : search_query 只有 (q,limit)，无法表达 folderId/inboxStatus；
 *                                  且回 {strategy,items} 与前端 {data,meta:{strategy}} 信封不同
 *
 * C. 本表以外的传输形态（非路由问题，单独跟踪）：
 *    - SSE 流：ai.ts 的 writeStream / streamChat（契约计划改 Tauri channel，P3）
 *    - 二进制下载：vault-files.ts 的 vaultFiles.download（direct fetch + blob）
 *    - URL 构造：assetUrl / attachmentUrl / downloadUrl（<img src>，桌面态需 convertFileSrc 或 base64）
 *    - 桌面桥：window.latticeDesktop.*（本就不是 HTTP）
 *    - AI / MCP / update 端点：22 + 3 + 1，规划在 P3/P4
 *
 * D. 记录的改进选项（P1-08 可选，本次未采用）：对「仅因某个参数表达不了」而排除的路由
 *    （POST /notes、PATCH /notes/:id、PATCH /folders/:id、GET /search），可在 args 构造器里
 *    检测到该参数时返回 undefined 从而**按请求**回落 HTTP。本次未采用是为了让映射表保持
 *    「要么完全可对齐、要么不进表」的简单判据，避免出现「同一路由时而 IPC 时而 HTTP」的
 *    隐式分叉，改由 P1-08 补齐 Rust 形参后一次性打开。
 */
