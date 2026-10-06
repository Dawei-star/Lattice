import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './mcp.controller.js';

export const mcpRouter = Router();

mcpRouter.get('/info', controller.getInfo);
// 项目级 MCP 配置（<Vault>/.lattice/mcp.json）：
// 读 = 设置页展示 + 聊天请求合并；写 = 设置页的 JSON 编辑器保存。
// body 允许 { mcpServers: {...} } 或裸映射，条目级校验在 mcp.project 里做（缺 command / URL 非法的条目被丢弃）。
mcpRouter.get('/project', controller.getProject);
mcpRouter.put('/project', validate({ body: z.record(z.string(), z.unknown()) }), controller.putProject);
