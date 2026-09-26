import { Router } from 'express';
import * as controller from './vault.controller.js';

export const vaultRouter = Router();

vaultRouter.get('/info', controller.getInfo);
vaultRouter.post('/migrate', controller.migrate);
