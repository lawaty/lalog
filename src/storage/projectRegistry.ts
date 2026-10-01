import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LaLogPaths } from './store';
import { Project, pickProjectColor, isAutoNamed } from '../core/projects';
import type { Session } from '../core/types';

interface ProjectFile {
  version: number;
  projects: Project[];
}

const VERSION = 1;

/** Inputs for {@link ProjectRegistry.ensureWorkspaceProject}. */
export interface EnsureWorkspaceOpts {
  /** `workspaceKey(wsPath)` — sha1 of the realpath, 10 hex chars. */
  wsKey: string;
  /** Current folder fsPath. */
  wsPath: string;
  /** `vscode.workspace.name` ?? `workspaceFolders[0].name` ?? `basename(wsPath)`. */
  vscName: string;
  /** ALL sessions from sessions.jsonl (used by the one-time legacy split). */
  history: Session[];
}

export interface EnsureWorkspaceResult {
  /** The project belonging to THIS workspace. */
  project: Project;
  /** True when the collapsed legacy record was split into per-workspace projects. */
  split: boolean;
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
    const project = this.newRecord(opts);
    this.projects.push(project);
    this.save();
    return project;
  }

  private newRecord(opts: { name: string; workspaceKey?: string; pathHint?: string }): Project {
    return {
      id: `prj_${crypto.randomBytes(4).toString('hex')}`,
      name: opts.name.trim(),
      color: pickProjectColor(this.projects.length),
      workspaceKeys: opts.workspaceKey ? [opts.workspaceKey] : [],
      pathHints: opts.pathHint ? [opts.pathHint] : [],
      createdAt: Date.now(),
      nameSource: 'auto',
    };
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
    // An explicit rename hands the name to the user: it stops tracking the
    // workspace from now on (ADR-030).
    p.nameSource = 'user';
    this.save();
  }

  /** Rename without touching `nameSource` (auto-tracking path). No-op if unchanged. */
  setNameTracked(id: string, name: string): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return;
    const next = name.trim();
    if (p.name === next) return;
    p.name = next;
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
   * Per-workspace project model (`lalog.multiProject = false`, ADR-030). Every
   * distinct workspace gets its own project, named from the VS Code workspace
   * name. There is no global union: a folder rename is a new workspace identity
   * (old sessions keep the old project; new ones get the new one).
   *
   *  - one-time: a flag-less (pre-0.7) collapsed legacy record (1 project,
   *    several claimed keys) is split into one project per key, named from each
   *    key's most recent session `workspaceName`; the pre-split file is kept as
   *    `projects.json.pre-split.bak`
   *  - then: claim `wsKey` (un-archive + hint + auto-name tracking), else create
   *
   * Other projects are never collapsed, unioned or dropped. Idempotent in every
   * branch — the split guard fails once more than one project exists.
   */
  ensureWorkspaceProject(opts: EnsureWorkspaceOpts): EnsureWorkspaceResult {
    const { wsKey, wsPath, vscName, history } = opts;
    const split = this.splitLegacyCollapse(history);

    const exact = this.projects.find((p) => p.workspaceKeys.includes(wsKey));
    if (exact) {
      let dirty = false;
      if (exact.archivedAt) {
        delete exact.archivedAt;
        dirty = true;
      }
      if (wsPath && !exact.pathHints.includes(wsPath)) {
        exact.pathHints.push(wsPath);
        dirty = true;
      }
      if (dirty) this.save();
      if (isAutoNamed(exact) && exact.name !== vscName) this.setNameTracked(exact.id, vscName);
      return { project: exact, split };
    }

    return { project: this.create({ name: vscName, workspaceKey: wsKey, pathHint: wsPath }), split };
  }

  /**
   * One-time split of the ADR-029 collapse record. Runs only while the registry
   * holds exactly one project claiming several workspace keys AND carries no
   * `nameSource` flag — pre-0.7 records are exactly what ADR-029's collapse
   * left behind. Records written after 0.7 always carry the flag; a multi-key
   * 'auto'/'user' project there is a deliberate union and is left alone.
   * Returns true when it rewrote the registry.
   */
  private splitLegacyCollapse(history: Session[]): boolean {
    const legacy = this.projects.length === 1 ? this.projects[0] : null;
    if (!legacy || legacy.workspaceKeys.length <= 1 || legacy.nameSource !== undefined) return false;

    const file = this.file();
    const bak = file + '.pre-split.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);

    const takenHints = new Set<string>();
    const takeHint = (name: string): string | undefined => {
      const hit = legacy.pathHints.find(
        (h) => !takenHints.has(h) && path.basename(h.replace(/\\/g, '/')) === name
      );
      if (hit) takenHints.add(hit);
      return hit;
    };

    const surviving: { key: string; name: string; hint?: string }[] = [];
    for (const key of legacy.workspaceKeys) {
      const sessions = history.filter((s) => s.workspaceKey === key);
      const name = mostRecentName(sessions) ?? 'Workspace';
      const hint = takeHint(name);
      // Nothing references this key — no session, no matching folder hint.
      if (sessions.length === 0 && !hint) continue;
      surviving.push(hint ? { key, name, hint } : { key, name });
    }

    // Fresh records: the collapsed id/color are dropped on purpose. A single
    // write means no partial intermediate states can land on disk, and a crash
    // before it simply re-runs the split next activation.
    this.projects = surviving.map((s) =>
      this.newRecord({ name: s.name, workspaceKey: s.key, pathHint: s.hint })
    );
    this.save();
    return true;
  }
}

/** `workspaceName` of the most recent session (by startedAt), or undefined. */
function mostRecentName(sessions: Session[]): string | undefined {
  let best: Session | undefined;
  for (const s of sessions) {
    if (!best || s.startedAt >= best.startedAt) best = s;
  }
  return best?.workspaceName;
}
