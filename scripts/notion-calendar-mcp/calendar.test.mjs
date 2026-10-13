import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDateValue,
  NotionCalendarClient,
  NotionCalendarError,
  NotionCalendarService,
  readConfig,
} from './calendar.mjs';

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return payload; },
});

function createFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const request = { url, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    const route = routes.find((candidate) => candidate.match(request));
    if (!route) throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${url}`);
    return jsonResponse(typeof route.response === 'function' ? route.response(request, calls) : route.response, route.status ?? 200);
  };
  return { fetchImpl, calls };
}

const schema = {
  object: 'data_source',
  id: 'source-1',
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    When: { id: 'date', name: 'When', type: 'date', date: {} },
  },
};

const page = (id, title = 'Planning', start = '2026-10-12T09:00:00+08:00') => ({
  object: 'page',
  id,
  url: `https://www.notion.so/${id}`,
  created_time: '2026-10-10T01:00:00.000Z',
  last_edited_time: '2026-10-10T02:00:00.000Z',
  properties: {
    Name: { id: 'title', type: 'title', title: [{ plain_text: title }] },
    When: { id: 'date', type: 'date', date: { start, end: null, time_zone: null } },
  },
});

function createService({ allowWrites = false, routes = [], databaseId = 'db-1' } = {}) {
  const fetchState = createFetch([
    { match: ({ url }) => url.endsWith('/databases/db-1'), response: { object: 'database', id: databaseId, data_sources: [{ id: 'source-1' }] } },
    { match: ({ url }) => url.endsWith('/data_sources/source-1'), response: schema },
    ...routes,
  ]);
  const client = new NotionCalendarClient({
    apiKey: 'secret-test-key',
    databaseId,
    apiBaseUrl: 'https://api.notion.test/v1',
    fetchImpl: fetchState.fetchImpl,
  });
  return { service: new NotionCalendarService({ client, allowWrites }), calls: fetchState.calls };
}

test('readConfig validates required credentials and keeps writes off by default', () => {
  assert.throws(() => readConfig({}), (error) => error.code === 'CONFIG_ERROR');
  const config = readConfig({ NOTION_API_KEY: 'secret', NOTION_DATABASE_ID: 'db', NOTION_CALENDAR_ALLOW_WRITES: 'false' });
  assert.equal(config.allowWrites, false);
  assert.equal(config.apiVersion, '2026-03-11');
});

test('buildDateValue validates date-only and datetime ranges', () => {
  assert.deepEqual(buildDateValue('2026-10-12', '2026-10-13'), { date: { start: '2026-10-12', end: '2026-10-13' } });
  assert.deepEqual(buildDateValue('2026-10-12T09:00:00+08:00', undefined, 'Asia/Shanghai'), {
    date: { start: '2026-10-12T09:00:00+08:00', time_zone: 'Asia/Shanghai' },
  });
  assert.throws(() => buildDateValue('2026-10-12', '2026-10-12'), /end 必须晚于 start/);
  assert.throws(() => buildDateValue('2026-10-12', '2026-10-12T09:00:00+08:00'), /同时使用日期/);
});

test('listEvents discovers the data source, queries it, paginates, and normalizes pages', async () => {
  const { service, calls } = createService({ routes: [
    {
      match: ({ url }) => url.endsWith('/data_sources/source-1/query'),
      response: (request) => request.body.start_cursor
        ? { results: [page('page-2', 'Review', '2026-10-13')], has_more: false, next_cursor: null }
        : { results: [page('page-1')], has_more: true, next_cursor: 'cursor-2' },
    },
  ] });
  const events = await service.listEvents({ startDate: '2026-10-12', endDate: '2026-10-20', query: 'Plan', limit: 2 });
  assert.deepEqual(events.map((event) => event.id), ['page-1', 'page-2']);
  assert.equal(events[0].title, 'Planning');
  assert.equal(events[0].allDay, false);
  const queryCalls = calls.filter((call) => call.url.endsWith('/query'));
  assert.equal(queryCalls.length, 2);
  assert.deepEqual(queryCalls[0].body.filter.and, [
    { property: 'When', date: { on_or_after: '2026-10-12' } },
    { property: 'When', date: { on_or_before: '2026-10-20' } },
    { property: 'Name', title: { contains: 'Plan' } },
  ]);
  assert.equal(queryCalls[1].body.start_cursor, 'cursor-2');
});

test('writes are blocked unless explicitly enabled', async () => {
  const readOnly = createService({ routes: [] }).service;
  await assert.rejects(() => readOnly.createEvent({ title: 'New', start: '2026-10-12' }), (error) => error.code === 'WRITE_DISABLED');

  const { service, calls } = createService({ allowWrites: true, routes: [
    { match: ({ url }) => url.endsWith('/pages'), response: page('created', 'New', '2026-10-12') },
    { match: ({ url }) => url.endsWith('/pages/page-1'), response: page('page-1', 'Updated', '2026-10-13') },
  ] });
  const created = await service.createEvent({ title: 'New', start: '2026-10-12' });
  assert.equal(created.id, 'created');
  const updated = await service.updateEvent({ pageId: 'page-1', title: 'Updated', start: '2026-10-13' });
  assert.equal(updated.title, 'Updated');
  await service.archiveEvent('page-1');
  assert.deepEqual(calls.filter((call) => call.init.method === 'POST' || call.init.method === 'PATCH').map((call) => call.init.method), ['POST', 'PATCH', 'PATCH']);
  assert.deepEqual(calls.at(-1).body, { in_trash: true });
});

test('Notion API failures become structured errors without exposing the token', async () => {
  const client = new NotionCalendarClient({
    apiKey: 'secret-do-not-leak',
    databaseId: 'db-1',
    apiBaseUrl: 'https://api.notion.test/v1',
    fetchImpl: async () => jsonResponse({ code: 'unauthorized', message: 'Invalid token' }, 401),
  });
  await assert.rejects(() => client.resolveDataSource(), (error) => {
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes('secret-do-not-leak'));
    return error instanceof NotionCalendarError;
  });
});
