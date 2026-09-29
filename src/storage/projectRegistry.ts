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

/** Inputs for {@link ProjectRegistry.ensureSingleProject}. */
export interface EnsureSingleOpts {
  wsKey: string;
  wsPath: string;
  /** Basename of the current folder, e.g. 'lalog'. */
  fallbackName: string;
  /** Every workspaceKey ever seen in sessions.jsonl. */
  historyKeys: string[];
}

export interface EnsureSingleResult {
  project: Project;
  /** Project ids removed by a collapse (empty when nothing was collapsed). */
  droppedIds: string[];
}

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

  /**
   * Single-project model (`lalog.multiProject = false`, ADR-029). One project
   * per window, named after the open folder and renameable, claiming the current
   * workspace key *and* every key in session history — which is what structurally
   * prevents a folder rename from orphaning history (`resolveProject` matches keys
   * only, with no basename fallback). Idempotent in every branch.
   *
   *  - 0 projects → create one named `fallbackName` claiming wsKey/wsPath + history
   *  - 1 project → un-archive it and claim wsKey + every history key; never renamed
   *  - 2+ → keep a survivor (name match, else oldest non-archived, else oldest),
   *    back up the pre-collapse file once, union every claim into the survivor
   */
  ensureSingleProject(opts: EnsureSingleOpts): EnsureSingleResult {
    const { wsKey, wsPath, fallbackName } = opts;
    const history = opts.historyKeys.filter((k) => !!k);

    const claim = (p: Project): void => {
      for (const k of [wsKey, ...history]) {
        if (!p.workspaceKeys.includes(k)) p.workspaceKeys.push(k);
      }
      if (wsPath && !p.pathHints.includes(wsPath)) p.pathHints.push(wsPath);
    };

    if (this.projects.length === 0) {
      const project = this.create({ name: fallbackName, workspaceKey: wsKey, pathHint: wsPath });
      claim(project);
      this.save();
      return { project, droppedIds: [] };
    }

    if (this.projects.length === 1) {
      const project = this.projects[0];
      if (project.archivedAt) delete project.archivedAt;
      claim(project);
      this.save();
      return { project, droppedIds: [] };
    }

    const survivor =
      this.projects.find((p) => p.name === fallbackName) ??
      [...this.projects].sort((a, b) => {
        const aLive = a.archivedAt ? 1 : 0;
        const bLive = b.archivedAt ? 1 : 0;
        if (aLive !== bLive) return aLive - bLive;
        return a.createdAt - b.createdAt;
      })[0];

    // Back up the original multi-project file exactly once so the earliest
    // pre-collapse state survives later activations.
    const file = this.file();
    const bak = file + '.pre-collapse.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);

    for (const p of this.projects) {
      if (p.id === survivor.id) continue;
      for (const k of p.workspaceKeys) {
        if (!survivor.workspaceKeys.includes(k)) survivor.workspaceKeys.push(k);
      }
      for (const h of p.pathHints) {
        if (!survivor.pathHints.includes(h)) survivor.pathHints.push(h);
      }
    }
    claim(survivor);
    if (survivor.archivedAt) delete survivor.archivedAt;

    const droppedIds = this.projects.filter((p) => p.id !== survivor.id).map((p) => p.id);
    this.projects = [survivor];
    this.save();
    return { project: survivor, droppedIds };
  }
}