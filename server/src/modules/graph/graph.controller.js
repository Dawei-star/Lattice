/** 图谱控制器 */
import * as service from './graph.service.js';

export async function getGraph(_req, res) {
  res.json({ data: service.buildGraph() });
}
