import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './versions.controller.js';

/**
 * 版本历史子路由，挂在 notesRouter 的 `/:id/versions` 下。
 * mergeParams 让它能读到父级的 :id，配合各自的 :versionId 做归属校验。
 */
const idParam = z.object({ id: z.string().uuid('笔记 ID 必须是合法 UUID') });
const versionParam = idParam.extend({ versionId: z.string().uuid('版本 ID 必须是合法 UUID') });

export const versionsRouter = Router({ mergeParams: true });

versionsRouter.get('/', validate({ params: idParam }), controller.listVersions);
versionsRouter.get('/:versionId', validate({ params: versionParam }), controller.getVersion);
versionsRouter.post('/:versionId/restore', validate({ params: versionParam }), controller.restoreVersion);
