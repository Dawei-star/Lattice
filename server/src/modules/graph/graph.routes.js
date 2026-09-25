import { Router } from 'express';
import * as controller from './graph.controller.js';

export const graphRouter = Router();

graphRouter.get('/', controller.getGraph);
