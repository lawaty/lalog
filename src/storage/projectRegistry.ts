import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LaLogPaths } from './store';
import { Project, pickProjectColor } from '../core/projects';

interface ProjectFile {
  version: number;
  projects: Project[];
}

const VERSION = 1;

/**
 * The projects registry: a curated config file (`~/.lalog/projects.json`),
 * separate from the append-only `sessions.jsonl`. Written atomically via
 * tmp+rename, matching the active-snapshot pattern.
 */
export class ProjectRegistry {
  private projects: Project[] = [];

  constructor(private paths: LaLogPaths) {
    this.load();
  }

  private file(): string {
    return path.join(this.paths.dataDir, 'projects.json');
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file(), 'utf8');
      const data = JSON.parse(raw) as ProjectFile;
      if (Array.isArray(data.projects)) this.projects = data.projects;
    } catch {
      this.projects = [];
    }
  }

  private save(): void {
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, projects: this.projects }, null, 2));
    fs.renameSync(tmp, file);
  }

  list(): Project[] {
    return this.projects;
  }

  get(id: string): Project | null {
    return this.projects.find((p) => p.id === id) ?? null;
  }

  create(opts: { name: string; workspaceKey?: string; pathHint?: string }): Project {
    const project: Project = {
      id: `prj_${crypto.randomBytes(4).toString('hex')}`,
      name: opts.name.trim(),
      color: pickProjectColor(this.projects.length),
      workspaceKeys: opts.workspaceKey ? [opts.workspaceKey] : [],
      pathHints: opts.pathHint ? [opts.pathHint] : [],
      createdAt: Date.now(),
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  /** Claim a workspace key for a project (idempotent). */
  addClaim(id: string, workspaceKey: string, pathHint?: string): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return;
    if (!p.workspaceKeys.includes(workspaceKey)) p.workspaceKeys.push(workspaceKey);
    if (pathHint && !p.pathHints.includes(pathHint)) p.pathHints.push(pathHint);
    this.save();
  }

  removeClaim(id: string, workspaceKey: string): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return;
    p.workspaceKeys = p.workspaceKeys.filter((k) => k !== workspaceKey);
    this.save();
  }

  rename(id: string, name: string): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return;
    p.name = name.trim();
    this.save();
  }

  archive(id: string, archived = true): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return;
    if (archived) p.archivedAt = Date.now();
    else delete p.archivedAt;
    this.save();
  }
}