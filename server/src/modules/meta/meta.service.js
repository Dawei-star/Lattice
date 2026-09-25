/**
 * 元信息聚合服务：把散落在各业务模块里的统计数据汇总成前端需要的总览。
 */
import * as linksService from '../links/links.service.js';
import * as notesService from '../notes/notes.service.js';

export function overview() {
  return {
    ...notesService.statistics(),
    danglingLinks: linksService.listDangling(),
  };
}
