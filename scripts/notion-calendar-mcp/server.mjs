#!/usr/bin/env node
/**
 * Local stdio MCP server for a Notion database shown by Notion Calendar.
 * The server uses only the public Notion API; it does not call Notion Calendar's private APIs.
 */
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = await import('zod');
const {
  NotionCalendarClient,
  NotionCalendarError,
  NotionCalendarService,
  readConfig,
} = await import('./calendar.mjs');

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const asError = (error) => ({
  isError: true,
  content: [{
    type: 'text',
    text: JSON.stringify({
      error: {
        code: error?.code ?? 'MCP_TOOL_ERROR',
        message: error?.message ?? String(error),
      },
    }),
  }],
});

const safeTool = (handler) => async (args) => {
  try {
    return await handler(args);
  } catch (error) {
    return asError(error);
  }
};

let service = null;
try {
  const config = readConfig();
  const client = new NotionCalendarClient(config);
  service = new NotionCalendarService({ client, allowWrites: config.allowWrites });
  process.stderr.write(`[notion-calendar-mcp] database=${config.databaseId} writes=${config.allowWrites ? 'enabled' : 'disabled'}\n`);
} catch (error) {
  process.stderr.write(`[notion-calendar-mcp] ${error?.message ?? error}\n`);
}

const server = new McpServer({ name: 'notion-calendar', version: '0.1.5' }, {
  instructions: [
    'Notion Calendar MCP：通过官方 Notion API 管理一个由 Notion Calendar 展示的数据库。',
    'NOTION_DATABASE_ID 指向日历数据库；服务会自动选择它的第一个 data source，也可用 NOTION_DATA_SOURCE_ID 指定。',
    '日历数据源必须包含一个 title 属性和一个 date 属性；需要时可用 NOTION_TITLE_PROPERTY / NOTION_DATE_PROPERTY 指定名称。',
    '创建、更新、归档属于写操作；默认关闭，设置 NOTION_CALENDAR_ALLOW_WRITES=true 后才会执行。',
  ].join('\n'),
});

const requireService = () => {
  if (!service) throw new NotionCalendarError('MCP 尚未配置，请设置 NOTION_API_KEY 和 NOTION_DATABASE_ID。', { code: 'CONFIG_ERROR' });
  return service;
};

server.tool('list_calendar_events', '列出 Notion 日历数据库中的事件，可按开始日期、结束日期或标题筛选。', {
  startDate: z.string().trim().max(40).optional(),
  endDate: z.string().trim().max(40).optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}, safeTool(async (args) => asText(await requireService().listEvents(args))));

server.tool('get_calendar_event', '按 Notion 页面 ID 读取一个日历事件。', {
  pageId: z.string().trim().min(1).max(120),
}, safeTool(async ({ pageId }) => asText(await requireService().getEvent(pageId))));

server.tool('create_calendar_event', '在 Notion 日历数据库中创建事件。需要 NOTION_CALENDAR_ALLOW_WRITES=true。', {
  title: z.string().trim().min(1).max(200),
  start: z.string().trim().min(1).max(40),
  end: z.string().trim().max(40).optional(),
  timeZone: z.string().trim().max(80).optional(),
}, safeTool(async (args) => asText(await requireService().createEvent(args))));

server.tool('update_calendar_event', '更新 Notion 日历事件的标题或日期。需要 NOTION_CALENDAR_ALLOW_WRITES=true。', {
  pageId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200).optional(),
  start: z.string().trim().max(40).optional(),
  end: z.string().trim().max(40).optional(),
  timeZone: z.string().trim().max(80).optional(),
}, safeTool(async (args) => asText(await requireService().updateEvent(args))));

server.tool('archive_calendar_event', '把 Notion 日历事件移入回收站。需要 NOTION_CALENDAR_ALLOW_WRITES=true。', {
  pageId: z.string().trim().min(1).max(120),
}, safeTool(async ({ pageId }) => asText(await requireService().archiveEvent(pageId))));

const transport = new StdioServerTransport();
await server.connect(transport);
