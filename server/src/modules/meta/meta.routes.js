import { Router } from 'express';
import * as controller from './meta.controller.js';

export const metaRouter = Router();

metaRouter.get('/overview', controller.getOverview);
