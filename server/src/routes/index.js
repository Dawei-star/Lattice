/**
 * API 路由总装配。
 * 所有业务路由统一挂在 /api 之下，与探针路由（/health、/ready）分开。
 */
import { Router } from 'express';
import { canvasRouter } from '../modules/canvas/canvas.routes.js';
import { foldersRouter } from '../modules/folders/folders.routes.js';
import { graphRouter } from '../modules/graph/graph.routes.js';
import { metaRouter } from '../modules/meta/meta.routes.js';
import { notesRouter } from '../modules/notes/notes.routes.js';
import { searchRouter } from '../modules/search/search.routes.js';
import { tagsRouter } from '../modules/tags/tags.routes.js';
import { vaultRouter } from '../modules/vault/vault.routes.js';

export const apiRouter = Router();

apiRouter.use('/notes', notesRouter);
apiRouter.use('/canvas', canvasRouter);
apiRouter.use('/folders', foldersRouter);
apiRouter.use('/tags', tagsRouter);
apiRouter.use('/search', searchRouter);
apiRouter.use('/graph', graphRouter);
apiRouter.use('/meta', metaRouter);
apiRouter.use('/vault', vaultRouter);
