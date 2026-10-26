/**
 * 「HTTP 路由 → Tauri 命令」映射表。
 *
 * 维护约定：
 *  1. **排序**：同一 method 下，静态路径必须先于「会吞掉它的」动态路径注册
 *     （如 `/experts/skills` 先于 `/experts/:id`），因为 `matchIpcRoute` 按注册顺序取首个命中。
 *  2. **只放真实可对齐的路由**：Rust 命令不存在（契约里仍待迁移的端点）、
 *     或入参/返回结构与前端消费方对不上的，一律不写进本表——写进去会在桌面形态下
 *     静默改变行为。排除项与证据见文件末尾「排除清单」，作为 P1-08 的核销议程。
 *  3. **参数名**：Tauri 2 默认把 JS 的 camelCase key 映射到 Rust 的 snake_case 形参，
 *     当前已映射的命令均未使用 `rename_all`，所以这里一律写 camelCase。
 *     参数只写 Rust 签名里真实存在的键，绝不携带多余键。
 *  4. **不做网络语义**：无需处理超时/重试/离线，见 ipc.ts 模块注释。
 *  5. 每条自定义 args/envelope 的路由都写 `note`，说明适配点，便于契约核对。
 */
import type { IpcCallContext, IpcRoute } from './ipc.ts';

type Args = Record<string, unknown>;

/** 必填字符串（缺值 → 桌面端由调用方报告 IPC_UNAVAILABLE） */
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
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** search_query 的命令结果带策略，IPC 侧还原 Express 的 data/meta 信封。 */
const searchEnvelope = (value: unknown) => {
  if (!value || typeof value !== 'object') return { data: value };
  const result = value as { items?: unknown; strategy?: unknown };
  const items = Array.isArray(result.items) ? result.items : [];
  return {
    data: items,
    meta: {
      strategy: typeof result.strategy === 'string' ? result.strategy : 'unknown',
      count: items.length,
    },
  };
};

const notesListEnvelope = (value: unknown) => {
  const result = value && typeof value === 'object'
    ? value as { items?: unknown; total?: unknown; limit?: unknown; offset?: unknown }
    : {};
  return {
    data: Array.isArray(result.items) ? result.items : [],
    meta: {
      total: typeof result.total === 'number' ? result.total : 0,
      limit: typeof result.limit === 'number' ? result.limit : undefined,
      offset: typeof result.offset === 'number' ? result.offset : undefined,
    },
  };
};

export const IPC_ROUTES: readonly IpcRoute[] = [
  // ---------------------------------------------------------------- GET
  // 静态路径优先（见约定 1）
  { method: 'GET', path: '/notes', command: 'note_list',
    args: (ctx) => ({
      folderId: optionalString(ctx.query.folderId),
      tagId: optionalString(ctx.query.tagId),
      inboxStatus: optionalString(ctx.query.inboxStatus),
      sort: optionalString(ctx.query.sort),
      limit: optionalNumber(ctx.query.limit),
      offset: optionalNumber(ctx.query.offset),
    }),
    envelope: notesListEnvelope,
    note: 'Rust 直接返回 items/total，IPC envelope 还原 Express 列表的 data/meta 分页形状' },
  { method: 'GET', path: '/search', command: 'search_query',
    args: (ctx) => {
      const q = asString(ctx.query.q).trim();
      if (!q) return undefined;
      return {
        q,
        limit: optionalNumber(ctx.query.limit),
        folderId: optionalString(ctx.query.folderId),
        inboxStatus: optionalString(ctx.query.inboxStatus),
      };
    },
    envelope: searchEnvelope,
    note: 'Rust 保留 strategy/items 结果，IPC envelope 还原 Express 的 data/meta 结构并传递 folderId/inboxStatus' },
  { method: 'GET', path: '/vault/attachments/references', command: 'vault_attachment_references',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      return path ? { path } : undefined;
    } },
  { method: 'GET', path: '/vault/attachments', command: 'vault_attachments_list' },
  { method: 'GET', path: '/vault/assets', command: 'vault_assets_list' },
  { method: 'GET', path: '/vault/files', command: 'vault_files_list' },
  { method: 'GET', path: '/vault/download', command: 'vault_download',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      return path ? { path } : undefined;
    },
    note: 'Rust 命令以 base64 返回文件内容，消费层仍收到 Express 的二进制数据编码' },
  // vault_info 于 P1-08 增量 10 回收：Rust 返回与 Express 一致的 profile 元数据
  { method: 'GET', path: '/vault/info', command: 'vault_info' },
  { method: 'GET', path: '/tags', command: 'tag_list' },
  { method: 'GET', path: '/graph', command: 'graph_build' },
  { method: 'GET', path: '/meta/overview', command: 'meta_overview' },
  { method: 'GET', path: '/mcp/project', command: 'mcp_project_get',
    note: '只读取 Vault/.lattice/mcp.json；不会启动外部 MCP Server' },
  // E3：MCP 运行态查询（不启动子进程）与用户主动「测试连接」（会启动并读取 tools/list）
  { method: 'POST', path: '/mcp/status', command: 'mcp_servers_status',
    args: (ctx) => {
      const body = obj(ctx);
      return Array.isArray(body.servers) ? { servers: body.servers } : undefined;
    },
    note: '不传 servers 时读项目级配置；只报告已缓存连接，不启动子进程' },
  { method: 'POST', path: '/mcp/test', command: 'mcp_server_test',
    args: (ctx) => ({ server: obj(ctx).server ?? {} }),
    note: '用户点「测试连接」：会启动子进程并读取 tools/list' },
  { method: 'GET', path: '/mcp/tools', command: 'mcp_tools_list',
    args: (ctx) => {
      const server = asString(ctx.query.server);
      return server ? { server } : undefined;
    } },
  // E3：官方 Registry 在线目录；断网/超时由前端回退静态目录（不阻断市场）
  { method: 'GET', path: '/mcp/registry', command: 'mcp_registry_search',
    args: (ctx) => {
      const query = optionalString(ctx.query.q);
      const limit = optionalNumber(ctx.query.limit);
      return { ...(query ? { query } : {}), ...(limit ? { limit } : {}) };
    },
    note: '免认证官方 Registry；网络失败返回错误，前端保留静态目录兜底' },
  // E4：前端对 MCP elicitation 表单的裁决（事件里带 id）
  { method: 'POST', path: '/mcp/elicitation', command: 'mcp_elicitation_reply',
    args: (ctx) => {
      const body = obj(ctx);
      const id = optionalString(body.id);
      if (!id) return undefined;
      const action = asString(body.action);
      if (!['accept', 'decline', 'cancel'].includes(action)) return undefined;
      const content = body.content && typeof body.content === 'object' ? body.content : null;
      return { id, action, content };
    },
    note: 'accept 必须携带对象 content；超时或未知 id 的错误直接回给调用方' },
  // note_index 于 P1-08 第 2 步回收：Rust 侧补上 `properties` 对象后与 Express 结构完全对齐
  // （`npm run test:desktop` 的 parity 测试确认 `note_index` 已不在差异清单内）
  { method: 'GET', path: '/notes/index', command: 'note_index' },
  { method: 'GET', path: '/notes/templates', command: 'note_templates_list' },
  // canvas_list 于 P1-08 第 2 步回收：Rust 改为返回 `{path,name,folderPath}` 对象数组后对齐
  { method: 'GET', path: '/canvas/files', command: 'canvas_list' },
  { method: 'GET', path: '/folders', command: 'folder_tree' },
  { method: 'GET', path: '/canvas', command: 'canvas_read',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      return path ? { path } : undefined;
    } },
  { method: 'GET', path: '/files/read', command: 'file_read',
    args: (ctx) => {
      const path = asString(ctx.query.path);
      if (!path) return undefined;
      return {
        path,
        offset: optionalNumber(ctx.query.offset),
        limit: optionalNumber(ctx.query.limit),
      };
    },
    note: '只读文件工具使用该命令；权限范围由 Agent Gateway 在调用前绑定' },
  { method: 'GET', path: '/files/find', command: 'file_find',
    args: (ctx) => ({
      pattern: optionalString(ctx.query.pattern),
      dir: optionalString(ctx.query.dir),
      fileType: optionalString(ctx.query.fileType),
    }) },
  { method: 'GET', path: '/files/grep', command: 'file_grep',
    args: (ctx) => {
      const query = asString(ctx.query.query);
      return query ? {
        query,
        dir: optionalString(ctx.query.dir),
        regex: flag(ctx.query.regex),
        fileType: optionalString(ctx.query.fileType),
      } : undefined;
    } },
  { method: 'GET', path: '/files/log', command: 'file_log',
    args: (ctx) => ({ limit: optionalNumber(ctx.query.limit) }) },
  { method: 'GET', path: '/experts/skills', command: 'skill_list' },
  // E4：只读扫描 ~/.claude/skills，返回可导入候选（不落盘）
  { method: 'GET', path: '/experts/skills/claude', command: 'skill_discover_claude',
    note: '只读扫描 ~/.claude/skills/*/SKILL.md；导入仍需前端确认后走 skill_save' },
  { method: 'GET', path: '/experts', command: 'expert_list' },
  { method: 'GET', path: '/review/health', command: 'review_health',
    args: (ctx) => ({
      staleDays: optionalNumber(ctx.query.staleDays),
      limit: optionalNumber(ctx.query.limit),
    }) },
  { method: 'GET', path: '/ai/memories', command: 'memory_list',
    args: (ctx) => ({ includeExpired: flag(ctx.query.includeExpired) }),
    note: '默认只返回未过期记忆；设置页可显式请求已过期条目用于清理' },
  { method: 'GET', path: '/update/check', command: 'update_check',
    args: (ctx) => ({ current: optionalString(ctx.query.current) }),
    note: '桌面端由 Rust 只读请求 GitHub Releases；不启用自动下载、安装或回滚' },
  // 动态路径
  { method: 'GET', path: /^\/notes\/(?<id>[^/]+)\/history$/, command: 'note_history_list',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },
  { method: 'GET', path: /^\/notes\/(?<id>[^/]+)\/history\/(?<version>[^/]+)$/, command: 'note_history_get',
    args: (ctx) => ({ id: asString(ctx.params.id), version: asString(ctx.params.version) }) },
  { method: 'GET', path: /^\/notes\/(?<id>(?!templates$|from-template$|daily$)[^/]+)$/, command: 'note_get',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },
  { method: 'GET', path: /^\/experts\/skills\/(?<id>[^/]+)\/export$/, command: 'skill_export',
    args: (ctx) => ({ id: asString(ctx.params.id) }),
    note: '导出 = 规范化 SKILL.md 全文 + references 清单；打包成 zip 留待后续' },
  { method: 'GET', path: /^\/experts\/(?<id>[^/]+)\/export$/, command: 'expert_export',
    args: (ctx) => ({ id: asString(ctx.params.id) }),
    note: '导出专家为 frontmatter + 正文的 .md；可再导入，内置专家导出为副本' },
  { method: 'GET', path: /^\/experts\/skills\/(?<id>[^/]+)$/, command: 'skill_get',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },
  { method: 'GET', path: /^\/experts\/(?<id>[^/]+)$/, command: 'expert_get',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },

  // --------------------------------------------------------------- POST
  { method: 'POST', path: '/notes', command: 'note_create',
    args: (ctx) => {
      const body = obj(ctx);
      const title = body.title === undefined ? null : body.title;
      const content = body.content === undefined ? '' : body.content;
      const properties = body.properties === undefined ? {} : body.properties;
      return {
        id: optionalString(body.id),
        title,
        content,
        folderId: body.folderId === undefined ? null : body.folderId,
        properties,
        confirmed: flag(body.confirmed),
      };
    },
    note: 'folderId 为 null 表示 Vault 根目录；创建请求总是显式传递该键以保持 Express 语义' },
  { method: 'POST', path: '/notes/from-template', command: 'note_create_from_template',
    args: (ctx) => {
      const body = obj(ctx);
      if (!body.template) return undefined;
      return {
        template: String(body.template),
        title: optionalString(body.title),
        date: optionalString(body.date),
        folderId: body.folderId === undefined ? null : body.folderId,
        confirmed: flag(body.confirmed),
      };
    } },
  { method: 'POST', path: '/notes/daily', command: 'note_create_daily',
    args: (ctx) => ({ date: optionalString(obj(ctx).date), confirmed: flag(obj(ctx).confirmed) }) },
  { method: 'POST', path: '/vault/attachments/validate', command: 'vault_attachment_validate',
    args: (ctx) => {
      const body = obj(ctx);
      return { content: asString(body.content), filePath: optionalString(body.filePath) };
    } },
  { method: 'POST', path: '/vault/migrate', command: 'vault_migrate_sqlite',
    args: (ctx) => {
      const body = obj(ctx);
      const sqlitePath = optionalString(body.sqlitePath);
      if (!sqlitePath) return undefined;
      return {
        sqlitePath,
        confirmed: flag(body.confirmed),
        secondConfirmed: flag(body.secondConfirmed),
      };
    },
    note: '迁移必须显式指定外部旧 SQLite 绝对路径；当前 .lattice/lattice.db 不得作为输入' },
  { method: 'POST', path: '/vault/attachments', command: 'vault_attachment_upload',
    args: async (ctx) => {
      const body = ctx.rawBody as { arrayBuffer?: () => Promise<ArrayBuffer>; type?: unknown } | null;
      const name = asString(ctx.query.name);
      if (!name || !body || typeof body.arrayBuffer !== 'function') return undefined;
      return {
        name,
        mimeType: typeof body.type === 'string' && body.type ? body.type : null,
        folder: optionalString(ctx.query.folder),
        bytes: new Uint8Array(await body.arrayBuffer()),
        confirmed: flag(ctx.query.confirmed),
      };
    },
    note: 'raw File/Blob 先转为 Uint8Array；保留 name/folder/confirmed query 与 Content-Type 语义' },
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
  { method: 'POST', path: '/ai/retrieval/preview', command: 'ai_retrieve',
    args: (ctx) => ({ request: obj(ctx) }),
    note: '桌面端在 Rust 索引 SQL 中先按 allowedPaths 过滤，再返回不可信块级引用' },
  { method: 'GET', path: '/ai/related', command: 'ai_related',
    args: (ctx) => {
      const noteId = asString(ctx.query.noteId).trim();
      if (!noteId) return undefined;
      return { noteId, limit: optionalNumber(ctx.query.limit) };
    },
    note: '复用本地 FTS/LIKE/向量投影返回笔记级元数据；不返回正文或写入持久化 AI 结果' },
  { method: 'GET', path: '/ai/suggestions', command: 'ai_suggestions',
    args: (ctx) => {
      const noteId = asString(ctx.query.noteId).trim();
      if (!noteId) return undefined;
      return { noteId, limit: optionalNumber(ctx.query.limit) };
    },
    note: '双链/标签候选均来自本地索引，接受建议仍由编辑器草稿和正常保存流程完成' },
  { method: 'POST', path: '/ai/digest', command: 'ai_digest',
    args: (ctx) => {
      const body = obj(ctx);
      return { date: optionalString(body.date), confirmed: true };
    },
    note: '用户点击每日摘要即确认；摘要是本地确定性汇总，写入仍经 WorkspaceService' },
  { method: 'POST', path: '/ai/test', command: 'ai_provider_test',
    args: (ctx) => ({ request: obj(ctx) }),
    note: '桌面端直接用内存 Provider 配置探测聊天或 embedding endpoint，不落盘请求正文和响应正文' },
  { method: 'GET', path: '/ai/settings', command: 'ai_settings_get',
    note: 'SQLite 只存脱敏文档（Key 恒为 masked:尾四位掩码）；providers 附 keyAvailable（env 密钥可解析）' },
  { method: 'PUT', path: '/ai/settings', command: 'ai_settings_set',
    args: (ctx) => ({ document: obj(ctx) }),
    note: 'W1：Rust 边界白名单脱敏——真实 Key 只留掩码；载荷缺 apiKey 时沿用旧掩码（编辑留空保持不变）' },
  { method: 'GET', path: '/ai/index/status', command: 'vault_index_stats',
    envelope: (value) => {
      const stats = value && typeof value === 'object' ? value as { notes?: unknown; dbBytes?: unknown } : {};
      const indexed = typeof stats.notes === 'number' ? stats.notes : 0;
      return { data: {
        pending: 0,
        failed: 0,
        configured: true,
        model: 'local-deterministic-unicode-ngram',
        indexed,
        totalNotes: indexed,
        totalChunks: indexed,
        dbBytes: typeof stats.dbBytes === 'number' ? stats.dbBytes : 0,
      } };
    },
    note: '复用 Rust 可重建索引统计；本地 embedding 是确定性投影，不引入账号额度或云端配额' },
  { method: 'POST', path: '/ai/index/reindex', command: 'vault_scan',
    note: '手动重建直接复用 vault_scan，扫描结果作为操作回执；不额外创建重复任务' },
  { method: 'GET', path: '/ai/history', command: 'file_log',
    args: (ctx) => ({ limit: optionalNumber(ctx.query.limit) }),
    note: 'AI 历史仅暴露本地文件操作审计摘要，不返回正文或模型提示词' },
  { method: 'POST', path: '/ai/memories', command: 'memory_save',
    args: (ctx) => {
      const body = obj(ctx);
      if (!body.kind || !body.content || !body.source) return undefined;
      return {
        id: optionalString(body.id),
        kind: asString(body.kind),
        content: asString(body.content),
        source: asString(body.source),
        expiresAt: optionalString(body.expiresAt),
        confirmed: flag(body.confirmed),
      };
    } },
  { method: 'POST', path: '/files/preview', command: 'file_preview',
    args: (ctx) => {
      const body = obj(ctx);
      const scope = {
        ...(typeof body.actor === 'string' ? { actor: asString(body.actor) } : {}),
        ...(typeof body.role === 'string' ? { role: asString(body.role) } : {}),
        ...(Array.isArray(body.allowedPaths) ? { allowedPaths: body.allowedPaths.map(asString) } : {}),
      };
      if (Array.isArray(body.actions)) return { actions: body.actions, ...scope };
      if (Object.keys(body).length === 0) return undefined;
      return { action: ctx.body, ...scope };
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
      const scope = {
        ...(typeof body.actor === 'string' ? { actor: asString(body.actor) } : {}),
        ...(typeof body.role === 'string' ? { role: asString(body.role) } : {}),
        ...(Array.isArray(body.allowedPaths) ? { allowedPaths: body.allowedPaths.map(asString) } : {}),
        ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: asString(body.idempotencyKey) } : {}),
      };
      if (Array.isArray(body.actions)) return { actions: body.actions, ...confirmation, ...scope };
      if (Object.keys(body).length === 0) return undefined;
      return { action: ctx.body, ...confirmation, ...scope };
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
  { method: 'POST', path: '/experts/skills/import', command: 'skill_import_preview',
    args: (ctx) => ({ source: asString(obj(ctx).source), value: asString(obj(ctx).value) }),
    note: '只解析预览，不落盘；保存仍走 skill_save 的确认流程' },
  // E4：LobeChat 角色卡导入预览（JSON 字符串，不落盘）
  { method: 'POST', path: '/experts/import', command: 'expert_import_preview',
    args: (ctx) => {
      const raw = obj(ctx).raw;
      return typeof raw === 'string' && raw.trim() ? { raw } : undefined;
    },
    note: '只解析角色卡并映射为专家文档；保存仍走 expert_save 的确认流程' },
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
    note: 'findingIds 为必填形参，缺失则由桌面端报告 IPC_UNAVAILABLE' },
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
    note: 'planId/planHash 为必填形参，缺失则由桌面端报告 IPC_UNAVAILABLE' },
  { method: 'POST', path: '/folders', command: 'folder_create',
    args: (ctx) => {
      const body = obj(ctx);
      const name = asString(body.name).trim();
      if (!name) return undefined;
      return {
        name,
        parentId: optionalString(body.parentId),
        sortOrder: optionalNumber(body.sortOrder),
        confirmed: flag(body.confirmed),
      };
    },
    note: 'Rust 由 folderId 反查磁盘父路径，响应仅返回 Express 单目录对象' },
  // 动态路径
  { method: 'POST', path: /^\/notes\/(?<id>[^/]+)\/duplicate$/, command: 'note_duplicate',
    args: (ctx) => {
      const body = obj(ctx);
      return {
        id: asString(ctx.params.id),
        folderId: body.folderId === undefined ? null : body.folderId,
        confirmed: flag(body.confirmed),
      };
    } },
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
  { method: 'PUT', path: '/vault/profile', command: 'vault_profile_set',
    args: (ctx) => {
      const body = obj(ctx);
      const { confirmed: _confirmed, secondConfirmed: _secondConfirmed, ...profile } = body;
      return { profile, confirmed: flag(body.confirmed) };
    },
    note: 'Express body 的 profile 字段与确认字段拆分为 Rust profile/confirmed 形参' },
  { method: 'PUT', path: '/mcp/project', command: 'mcp_project_set',
    args: (ctx) => {
      const body = obj(ctx);
      const { confirmed: _confirmed, secondConfirmed: _secondConfirmed, ...document } = body;
      return { document, confirmed: flag(body.confirmed) };
    },
    note: '保存前拆出确认字段；Rust 仅归一化并原子写入项目配置，不启动 sidecar' },
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
  { method: 'PATCH', path: /^\/notes\/(?<id>[^/]+)$/, command: 'note_update',
    args: (ctx) => {
      const body = obj(ctx);
      const args: Args = {
        id: asString(ctx.params.id),
        title: has(body, 'title') ? body.title : null,
        content: has(body, 'content') ? body.content : null,
        isPinned: has(body, 'isPinned') ? body.isPinned : null,
        properties: has(body, 'properties') ? body.properties : null,
        expectedHash: has(body, 'expectedHash') ? optionalString(body.expectedHash) : null,
        confirmed: has(body, 'confirmed') ? flag(body.confirmed) : false,
      };
      // Nested Option in Rust preserves: omitted = keep, null = move to root, string = move to folder.
      if (has(body, 'folderId')) args.folderId = body.folderId === null ? null : String(body.folderId);
      return args;
    },
    note: 'folderId 使用 Rust Option<Option<String>> 保留省略/根目录/目标目录三态' },
  { method: 'PATCH', path: '/canvas/file', command: 'canvas_move',
    args: (ctx) => {
      const body = obj(ctx);
      const fromPath = optionalString(body.fromPath);
      const toPath = optionalString(body.toPath);
      if (!fromPath || !toPath) return undefined;
      return { fromPath, toPath, confirmed: flag(body.confirmed) };
    } },
  { method: 'PATCH', path: /^\/folders\/(?<id>[^/]+)$/, command: 'folder_update',
    args: (ctx) => {
      const body = obj(ctx);
      if (!has(body, 'name') && !has(body, 'parentId') && !has(body, 'sortOrder')) return undefined;
      return {
        id: asString(ctx.params.id),
        name: has(body, 'name') ? optionalString(body.name) : null,
        parentId: has(body, 'parentId') ? (body.parentId === null || body.parentId === '' ? null : String(body.parentId)) : undefined,
        sortOrder: has(body, 'sortOrder') ? optionalNumber(body.sortOrder) : null,
        confirmed: flag(body.confirmed),
      };
    },
    note: 'parentId 省略表示保持，显式 null 表示移到根；Rust 返回 Express 单目录对象' },

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
  { method: 'DELETE', path: /^\/tags\/(?<id>[^/]+)$/, command: 'tag_delete',
    args: (ctx) => ({ id: asString(ctx.params.id) }) },
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
  { method: 'DELETE', path: /^\/folders\/(?<id>[^/]+)$/, command: 'folder_delete',
    args: (ctx) => ({
      id: asString(ctx.params.id),
      confirmed: flag(obj(ctx).confirmed),
      secondConfirmed: flag(obj(ctx).secondConfirmed),
    }),
    note: 'Rust 返回 Express 的 {deletedFolderCount,affectedNoteCount} 摘要' },
  { method: 'DELETE', path: /^\/ai\/memories\/(?<id>[^/]+)$/, command: 'memory_delete',
    args: (ctx) => ({ id: asString(ctx.params.id), confirmed: flag(obj(ctx).confirmed) }) },
  { method: 'PUT', path: /^\/ai\/memories\/(?<id>[^/]+)$/, command: 'memory_save',
    args: (ctx) => {
      const body = obj(ctx);
      if (!body.kind || !body.content || !body.source) return undefined;
      return {
        id: asString(ctx.params.id),
        kind: asString(body.kind),
        content: asString(body.content),
        source: asString(body.source),
        expiresAt: optionalString(body.expiresAt),
        confirmed: flag(body.confirmed),
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
export const IPC_PENDING_COMMANDS: readonly string[] = [];

/**
 * 已排除的路由（`METHOD /path`，动态段写 `:id` 形态）。
 *
 * 约束：**不得**同时出现在 `IPC_ROUTES` 中——进表项与排除项是互斥的，
 * 由 ipc-routes-contract 测试守住。排除理由见上方注释块 A/B 两节。
 */
export const IPC_EXCLUDED_ROUTES: readonly string[] = [
  // A. 明确不迁移（1）
  'GET /health',
];

/**
 * 排除清单（1 条，逐条经代码核对，供 P1-09 核销）。
 *
 * A. 明确不迁移（1 条）：
 *    - GET  /health                            → 契约 ⛔（桌面单机无探针需求），且前端无调用点
 *
 * B. 已收回的历史排除项：
 *    - POST /notes               : 已回收，note_create 支持 folderId
 *    - PATCH /notes/:id          : 已回收，note_update 支持 folderId 三态移动
 *    - GET  /search               : 已回收，search_query 支持 folderId/inboxStatus，IPC envelope 还原
 *                              Express 的 {data,meta:{query,strategy,count}} 消费形状
 *
 * B. 本表以外的传输形态（非路由问题，单独跟踪）：
 *    - URL 构造：assetUrl / attachmentUrl（桌面预览通过 VaultImage/Blob IPC 消费）
 *    - 二进制下载：vault-files.ts 的 vaultFiles.download 已在桌面态使用 IPC base64 + Blob
 *    - 桌面桥：window.latticeDesktop.*（本就不是 HTTP）
 *    - AI 会话正文、MCP：仍需独立数据模型或 sidecar，见 P3/P4 外部验收清单
 *
 * C. 参数契约已在 P1-08 补齐；args 返回 undefined 仅表示该桌面请求不可表达，
 *    由 client.ts 统一转为 IPC_UNAVAILABLE，不再隐式访问 HTTP。
 */
