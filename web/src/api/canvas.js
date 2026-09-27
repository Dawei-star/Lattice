import { http } from './client.js';

export const canvasApi = {
  get: () => http.get('/canvas'),
  save: (document) => http.put('/canvas', document),
};
