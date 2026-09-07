import { Session } from './types';

/** A project is a flat registry over workspace identities (derive-on-read). */
export interface Project {
  id: string;
  name: string;
  color: string;
  /** Workspace keys this project claims. Every session with a matching key belongs to it. */
  workspaceKeys: string[];
  /** Human-readable folder hints for the management UI (never matched against). */
  pathHints: string[];
  createdAt: number;
  archivedAt?: number;
}

/** Resolve which project a session belongs to. Pure — no I/O. */
export function resolveProject(session: Session, projects: Project[]): Project | null {
  if (session.projectId) {
    // Explicit beats derived, even when the project is archived.
    return projects.find((p) => p.id === session.projectId) ?? null;
  }
  return (
    projects.find(
      (p) => !p.archivedAt && p.workspaceKeys.includes(session.workspaceKey)
    ) ?? null
  );
}

/** Human label for a session in a project context. */
export function resolveProjectName(session: Session, projects: Project[]): string {
  return resolveProject(session, projects)?.name ?? session.workspaceName;
}

export function isProjectColor(c: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(c);
}

export const PROJECT_COLORS = [
  '#2ea043',
  '#409cd4',
  '#d4a72c',
  '#9b59b6',
  '#e05d3f',
  '#2bb0a8',
  '#b06a3c',
  '#5f6caf',
  '#c257a1',
  '#678a4a',
];

export function pickProjectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length];
}