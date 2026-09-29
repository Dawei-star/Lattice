import { Router } from 'express';
import * as controller from './mcp.controller.js';

export const mcpRouter = Router();

mcpRouter.get('/info', controller.getInfo);
