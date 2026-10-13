export const DEFAULT_NOTION_API_VERSION = '2026-03-11';
export const DEFAULT_NOTION_API_BASE_URL = 'https://api.notion.com/v1';

const WRITE_ENABLED_VALUES = new Set(['true', '1', 'yes']);
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export class NotionCalendarError extends Error {
  constructor(message, { code = 'NOTION_CALENDAR_ERROR', status, details } = {}) {
    super(message);
    this.name = 'NotionCalendarError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function readConfig(env = process.env) {
  const apiKey = String(env.NOTION_API_KEY ?? '').trim();
  const databaseId = String(env.NOTION_DATABASE_ID ?? '').trim();
  if (!apiKey) {
    throw new NotionCalendarError('缺少 NOTION_API_KEY，请配置 Notion Internal Integration Token。', { code: 'CONFIG_ERROR' });
  }
  if (!databaseId) {
    throw new NotionCalendarError('缺少 NOTION_DATABASE_ID，请配置日历数据库 ID。', { code: 'CONFIG_ERROR' });
  }
  return {
    apiKey,
    databaseId,
    dataSourceId: String(env.NOTION_DATA_SOURCE_ID ?? '').trim() || null,
    titleProperty: String(env.NOTION_TITLE_PROPERTY ?? '').trim() || null,
    dateProperty: String(env.NOTION_DATE_PROPERTY ?? '').trim() || null,
    apiVersion: String(env.NOTION_API_VERSION ?? '').trim() || DEFAULT_NOTION_API_VERSION,
    apiBaseUrl: String(env.NOTION_API_BASE_URL ?? '').trim().replace(/\/$/, '') || DEFAULT_NOTION_API_BASE_URL,
    allowWrites: WRITE_ENABLED_VALUES.has(String(env.NOTION_CALENDAR_ALLOW_WRITES ?? '').trim().toLowerCase()),
  };
}

export class NotionCalendarClient {
  constructor({
    apiKey,
    databaseId,
    dataSourceId = null,
    titleProperty = null,
    dateProperty = null,
    apiVersion = DEFAULT_NOTION_API_VERSION,
    apiBaseUrl = DEFAULT_NOTION_API_BASE_URL,
    fetchImpl = globalThis.fetch,
  }) {
    if (typeof fetchImpl !== 'function') {
      throw new NotionCalendarError('当前 Node.js 没有可用的 fetch 实现。', { code: 'RUNTIME_ERROR' });
    }
    this.apiKey = String(apiKey ?? '').trim();
    this.databaseId = String(databaseId ?? '').trim();
    this.dataSourceId = String(dataSourceId ?? '').trim() || null;
    this.titleProperty = String(titleProperty ?? '').trim() || null;
    this.dateProperty = String(dateProperty ?? '').trim() || null;
    this.apiVersion = String(apiVersion ?? DEFAULT_NOTION_API_VERSION).trim();
    this.apiBaseUrl = String(apiBaseUrl ?? DEFAULT_NOTION_API_BASE_URL).trim().replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this._dataSource = null;
    this._schema = null;
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Notion-Version': this.apiVersion,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.message || payload?.error || `Notion API 请求失败（HTTP ${response.status}）`;
      throw new NotionCalendarError(message, {
        code: payload?.code || 'NOTION_API_ERROR',
        status: response.status,
        details: payload,
      });
    }
    return payload;
  }

  async resolveDataSource() {
    if (this._dataSource) return this._dataSource;
    if (this.dataSourceId) {
      const dataSource = await this.request(`/data_sources/${encodeURIComponent(this.dataSourceId)}`);
      this._dataSource = { ...dataSource, legacy: false };
      return this._dataSource;
    }

    const database = await this.request(`/databases/${encodeURIComponent(this.databaseId)}`);
    const discovered = Array.isArray(database?.data_sources) ? database.data_sources[0] : null;
    if (discovered?.id) {
      const dataSource = await this.request(`/data_sources/${encodeURIComponent(discovered.id)}`);
      this._dataSource = { ...dataSource, legacy: false, databaseId: this.databaseId };
      return this._dataSource;
    }

    // Connections pinned to the pre-2025-09-03 API expose the schema directly.
    if (database?.properties && typeof database.properties === 'object') {
      this._dataSource = { ...database, id: this.databaseId, legacy: true };
      return this._dataSource;
    }
    throw new NotionCalendarError('没有找到可用的 Notion data source，请确认数据库已分享给该 Integration。', { code: 'SCHEMA_ERROR' });
  }

  async schema() {
    if (this._schema) return this._schema;
    const dataSource = await this.resolveDataSource();
    const properties = dataSource?.properties;
    if (!properties || typeof properties !== 'object') {
      throw new NotionCalendarError('Notion data source 没有返回属性结构，请检查 Integration 的读取权限。', { code: 'SCHEMA_ERROR' });
    }

    const entries = Object.entries(properties).map(([key, property]) => ({
      key,
      name: String(property?.name ?? key),
      type: property?.type,
      property,
    }));
    const title = pickProperty(entries, this.titleProperty, 'title');
    const date = pickProperty(entries, this.dateProperty, 'date');
    if (!title || !date) {
      const available = entries.map((entry) => `${entry.name}(${entry.type ?? 'unknown'})`).join('、') || '无';
      throw new NotionCalendarError(`日历数据源需要一个 title 属性和一个 date 属性；当前属性：${available}`, { code: 'SCHEMA_ERROR' });
    }
    this._schema = { title, date, properties: entries };
    return this._schema;
  }

  async query({ filter, sorts, limit = 50 } = {}) {
    const dataSource = await this.resolveDataSource();
    const endpoint = dataSource.legacy
      ? `/databases/${encodeURIComponent(this.databaseId)}/query`
      : `/data_sources/${encodeURIComponent(dataSource.id)}/query`;
    const pages = [];
    let cursor;
    const target = Math.max(1, Math.min(Number(limit) || 50, 100));
    do {
      const payload = await this.request(endpoint, {
        method: 'POST',
        body: {
          page_size: Math.min(100, target - pages.length),
          result_type: 'page',
          ...(filter ? { filter } : {}),
          ...(sorts?.length ? { sorts } : {}),
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      });
      pages.push(...(Array.isArray(payload?.results) ? payload.results : []));
      cursor = payload?.has_more && payload?.next_cursor ? payload.next_cursor : null;
    } while (cursor && pages.length < target);
    return pages.slice(0, target);
  }

  async retrievePage(pageId) {
    return this.request(`/pages/${encodeURIComponent(pageId)}`);
  }

  async createPage({ properties }) {
    const dataSource = await this.resolveDataSource();
    const parent = dataSource.legacy ? { database_id: this.databaseId } : { data_source_id: dataSource.id };
    return this.request('/pages', { method: 'POST', body: { parent, properties } });
  }

  async updatePage(pageId, body) {
    return this.request(`/pages/${encodeURIComponent(pageId)}`, { method: 'PATCH', body });
  }
}

export class NotionCalendarService {
  constructor({ client, allowWrites = false } = {}) {
    if (!client) throw new NotionCalendarError('Notion Calendar client 未初始化。', { code: 'RUNTIME_ERROR' });
    this.client = client;
    this.allowWrites = allowWrites === true;
  }

  async listEvents({ startDate, endDate, query, limit = 50 } = {}) {
    const schema = await this.client.schema();
    const filters = [];
    if (startDate) filters.push({ property: schema.date.key, date: { on_or_after: validateDateValue(startDate, 'startDate') } });
    if (endDate) filters.push({ property: schema.date.key, date: { on_or_before: validateDateValue(endDate, 'endDate') } });
    if (query) filters.push({ property: schema.title.key, title: { contains: String(query).trim() } });
    const filter = filters.length === 1 ? filters[0] : filters.length > 1 ? { and: filters } : undefined;
    const pages = await this.client.query({
      filter,
      limit,
      sorts: [{ property: schema.date.key, direction: 'ascending' }],
    });
    return pages.map((page) => normalizeEvent(page, schema));
  }

  async getEvent(pageId) {
    const schema = await this.client.schema();
    const page = await this.client.retrievePage(requireText(pageId, 'pageId'));
    return normalizeEvent(page, schema);
  }

  async createEvent({ title, start, end, timeZone }) {
    this.assertWritesEnabled();
    const schema = await this.client.schema();
    const properties = {
      [schema.title.key]: buildTitleValue(requireText(title, 'title')),
      [schema.date.key]: buildDateValue(start, end, timeZone),
    };
    const page = await this.client.createPage({ properties });
    return normalizeEvent(page, schema);
  }

  async updateEvent({ pageId, title, start, end, timeZone }) {
    this.assertWritesEnabled();
    const schema = await this.client.schema();
    const properties = {};
    if (title !== undefined) properties[schema.title.key] = buildTitleValue(requireText(title, 'title'));
    if (start !== undefined || end !== undefined || timeZone !== undefined) {
      if (start === undefined) throw new NotionCalendarError('更新结束时间时必须同时提供 start。', { code: 'INVALID_ARGUMENT' });
      properties[schema.date.key] = buildDateValue(start, end, timeZone);
    }
    if (!Object.keys(properties).length) {
      throw new NotionCalendarError('至少提供 title 或日期字段中的一项。', { code: 'INVALID_ARGUMENT' });
    }
    const page = await this.client.updatePage(requireText(pageId, 'pageId'), { properties });
    return normalizeEvent(page, schema);
  }

  async archiveEvent(pageId) {
    this.assertWritesEnabled();
    const schema = await this.client.schema();
    const page = await this.client.updatePage(requireText(pageId, 'pageId'), { in_trash: true });
    return normalizeEvent(page, schema);
  }

  assertWritesEnabled() {
    if (!this.allowWrites) {
      throw new NotionCalendarError('写入工具默认关闭，请设置 NOTION_CALENDAR_ALLOW_WRITES=true 后重试。', { code: 'WRITE_DISABLED' });
    }
  }
}

function pickProperty(entries, configuredName, type) {
  if (configuredName) {
    const match = entries.find((entry) => entry.key === configuredName || entry.name === configuredName);
    return match?.type === type ? match : null;
  }
  return entries.find((entry) => entry.type === type) ?? null;
}

export function validateDateValue(value, field = 'date') {
  const normalized = String(value ?? '').trim();
  if (!DATE_ONLY_PATTERN.test(normalized) && !ISO_DATE_TIME_PATTERN.test(normalized)) {
    throw new NotionCalendarError(`${field} 必须是 YYYY-MM-DD 或 ISO 8601 日期时间。`, { code: 'INVALID_ARGUMENT' });
  }
  return normalized;
}

export function buildDateValue(start, end, timeZone) {
  const normalizedStart = validateDateValue(start, 'start');
  const normalizedEnd = end === undefined || end === null || String(end).trim() === '' ? null : validateDateValue(end, 'end');
  if (normalizedEnd && DATE_ONLY_PATTERN.test(normalizedStart) !== DATE_ONLY_PATTERN.test(normalizedEnd)) {
    throw new NotionCalendarError('start 和 end 必须同时使用日期或日期时间格式。', { code: 'INVALID_ARGUMENT' });
  }
  if (normalizedEnd && normalizedStart >= normalizedEnd) {
    throw new NotionCalendarError('end 必须晚于 start。', { code: 'INVALID_ARGUMENT' });
  }
  return {
    date: {
      start: normalizedStart,
      ...(normalizedEnd ? { end: normalizedEnd } : {}),
      ...(timeZone ? { time_zone: String(timeZone).trim() } : {}),
    },
  };
}

export function normalizeEvent(page, schema) {
  const titleProperty = page?.properties?.[schema.title.key];
  const dateProperty = page?.properties?.[schema.date.key];
  const date = dateProperty?.date ?? null;
  const start = date?.start ?? null;
  return {
    id: page?.id ?? null,
    title: readPlainText(titleProperty?.title ?? titleProperty?.rich_text ?? []),
    start,
    end: date?.end ?? null,
    timeZone: date?.time_zone ?? null,
    allDay: Boolean(start && DATE_ONLY_PATTERN.test(start)),
    url: page?.url ?? null,
    archived: Boolean(page?.archived || page?.in_trash),
    createdTime: page?.created_time ?? null,
    lastEditedTime: page?.last_edited_time ?? null,
  };
}

function readPlainText(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => item?.plain_text ?? item?.text?.content ?? '')
    .join('');
}

function buildTitleValue(title) {
  return { title: [{ type: 'text', text: { content: title } }] };
}

function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new NotionCalendarError(`${field} 不能为空。`, { code: 'INVALID_ARGUMENT' });
  return text;
}
