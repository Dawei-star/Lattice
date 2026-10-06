import * as registry from './experts.registry.js';

export function list(_req, res) {
  res.json({ data: registry.listExperts() });
}

export function route(req, res) {
  res.json({ data: registry.suggestExperts(req.valid.body.message, { excludeId: req.valid.body.excludeId ?? null }) });
}

export function detail(req, res) {
  res.json({ data: registry.getExpert(req.valid.params.id) });
}

export function create(req, res) {
  res.status(201).json({ data: registry.saveExpert(req.valid.body) });
}

export function update(req, res) {
  res.json({ data: registry.saveExpert(req.valid.body, req.valid.params.id) });
}

export function remove(req, res) {
  res.json({ data: registry.deleteExpert(req.valid.params.id) });
}

export function listSkills(_req, res) {
  res.json({ data: registry.listSkills() });
}

export function skillDetail(req, res) {
  res.json({ data: registry.readSkill(req.valid.params.id, { includeContent: true }) });
}

export function createSkill(req, res) {
  res.status(201).json({ data: registry.saveSkill(req.valid.body) });
}

export function updateSkill(req, res) {
  res.json({ data: registry.saveSkill(req.valid.body, req.valid.params.id) });
}

export function removeSkill(req, res) {
  res.json({ data: registry.deleteSkill(req.valid.params.id) });
}
