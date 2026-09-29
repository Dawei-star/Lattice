const clients = new Set();

/**
 * Keep the renderer informed after the SQLite projection catches up with the
 * Markdown source of truth. The endpoint is same-origin and carries no file
 * contents, only the change metadata needed to refresh UI.
 */
export function subscribeVaultEvents(response) {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();
  response.write('retry: 1000\n\n');

  clients.add(response);
  const heartbeat = setInterval(() => {
    if (response.destroyed || response.writableEnded) return;
    try {
      response.write(': heartbeat\n\n');
    } catch {
      cleanup();
    }
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(response);
  };
  response.once('close', cleanup);
  response.once('error', cleanup);
  return cleanup;
}

export function publishVaultEvent(event) {
  const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
  for (const response of clients) {
    if (response.destroyed || response.writableEnded) {
      clients.delete(response);
      continue;
    }
    try {
      response.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(response);
    }
  }
}
