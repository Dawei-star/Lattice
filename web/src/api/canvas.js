import { http } from './client.js';

export const canvasApi = {
  list: () => http.get('/canvas/files'),
  get: (path = '画板.canvas') => http.get('/canvas', { query: { path } }),
  save: (path, document) => http.put('/canvas', document, { query: { path } }),
  move: (fromPath, toPath) => http.patch('/canvas/file', { fromPath, toPath }),
};
