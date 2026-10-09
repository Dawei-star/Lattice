import * as health from './knowledge-health.service.js';
import { requireFileConfirmation } from '../../lib/file-confirmation.js';

export function getHealth(req, res) {
  res.json({ data: health.scan(req.valid.query) });
}

export function createPlan(req, res) {
  res.json({ data: health.createRepairPlan(req.valid.body) });
}

export function executePlan(req, res) {
  const deletes = health.planRequiresSecondConfirmation(req.valid.body);
  requireFileConfirmation(req, { destructive: deletes });
  res.json({
    data: health.executeRepairPlan({
      planId: req.valid.body.planId,
      planHash: req.valid.body.planHash,
      actor: req.workspacePrincipal?.actor ?? 'local-user',
    }),
  });
}
