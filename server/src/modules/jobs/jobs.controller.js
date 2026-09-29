import { NotFoundError } from '../../lib/errors.js';
import { cancelJob, getJob, listJobs } from '../../lib/jobs.js';

export function list(req, res) {
  res.json({ data: listJobs(req.valid.query) });
}

export function detail(req, res) {
  const job = getJob(req.valid.params.id);
  if (!job) throw new NotFoundError('后台任务不存在');
  res.json({ data: job });
}

export function cancel(req, res) {
  const job = getJob(req.valid.params.id);
  if (!job) throw new NotFoundError('后台任务不存在');
  res.json({ data: cancelJob(job.id) });
}
