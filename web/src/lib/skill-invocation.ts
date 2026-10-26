import type { Skill } from '../api/experts.ts';

/** 输入框是否处于 `/技能` 唤起态：只认行首的单个 slug，避免误触正文里的斜杠。 */
export interface SkillSlashQuery {
  active: boolean;
  query: string;
}

export function parseSkillSlash(draft: string): SkillSlashQuery {
  const match = /^\/([^\s/]*)$/u.exec(draft);
  return match ? { active: true, query: match[1] } : { active: false, query: '' };
}

export function skillDisplayName(skill: Skill): string {
  const title = typeof skill.title === 'string' ? skill.title.trim() : '';
  const name = typeof skill.name === 'string' ? skill.name.trim() : '';
  return title || name || skill.id;
}

/** `/` 面板候选：启用中、按标题排序，query 匹配 id / name / title / description。 */
export function filterInvocableSkills(skills: Skill[], query: string): Skill[] {
  const needle = query.trim().toLowerCase();
  return skills
    .filter((skill) => skill.enabled !== false && typeof skill.id === 'string' && skill.id.trim().length > 0)
    .filter((skill) => {
      if (!needle) return true;
      return [skill.id, skill.name, skill.title, skill.description]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
    })
    .sort((left, right) => skillDisplayName(left).localeCompare(skillDisplayName(right), 'zh-Hans-CN'));
}

export function addInvokedSkill(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

export function removeInvokedSkill(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id);
}
