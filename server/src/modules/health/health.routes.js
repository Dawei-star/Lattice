/**
 * 健康检查。
 *  /health  存活探针：进程还在就返回 200，不做任何 IO
 *  /ready   就绪探针：真的打一次数据库，确认可以对外服务
 */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { config } from '../../config/index.js';

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/health', (_req, res) => {
  res.json({
    data: {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      env: config.env,
    },
  });
});

healthRouter.get('/ready', (_req, res) => {
  try {
    getDb().prepare('SELECT 1 AS ok').get();
    res.json({ data: { status: 'ready', database: 'up' } });
  } catch (error) {
    res.status(503).json({
      error: { code: 'NOT_READY', message: '数据库不可用', details: error.message },
    });
  }
});
