import { http } from './client.js';

export const aiApi = {
  chat: (input, options = {}) => http.post('/ai/chat', input, options),
  preview: (input, options = {}) => http.post('/ai/operations/preview', input, options),
  execute: (input, options = {}) => http.post('/ai/operations/execute', input, options),
  history: (options = {}) => http.get('/ai/history', options),
};
