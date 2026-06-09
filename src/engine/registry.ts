import type { Skill } from './types.js';

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (this.skills.has(skill.name)) throw new Error(`skill already registered: ${skill.name}`);
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill {
    const s = this.skills.get(name);
    if (!s) throw new Error(`unknown skill: ${name}`);
    return s;
  }
}
