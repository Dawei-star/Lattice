import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { normalizeVaultRelativePath } from '../../vault/path.js';
import * as controller from './vault.controller.js';

export const vaultRouter = Router();

const assetQuery = z.object({
  path: z.string().min(1).max(1024).refine((value) => {
    try {
      normalizeVaultRelativePath(value, '');
      return true;
    } catch {
      return false;
    }
  }, '图片路径必须是 Vault 内的相对路径'),
});

vaultRouter.get('/info', controller.getInfo);
vaultRouter.get('/assets', controller.listAssets);
vaultRouter.get('/asset', validate({ query: assetQuery }), controller.readAsset);
vaultRouter.post('/migrate', controller.migrate);
