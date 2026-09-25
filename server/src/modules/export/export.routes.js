import { Router } from 'express';
import * as controller from './export.controller.js';

export const exportRouter = Router();

// 触发一次全量静态站点导出，返回落盘目录与预览入口
exportRouter.post('/static', controller.exportStaticSite);
