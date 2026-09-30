import { Router } from 'express';
import * as controller from './update.controller.js';

export const updateRouter = Router();

updateRouter.get('/check', controller.checkUpdate);
