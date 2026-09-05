import * as vscode from 'vscode';
import { Session } from '../core/types';
import { fmtDuration } from '../prompts/promptCoordinator';
import { splitActiveMinutes } from '../reporting/spans';
import { ThresholdsMs } from '../core/config';

export type SessionTreeKind =
  | 'session'
  | 'day'
  | 'desc'
  | 'time'
  | 'meta'
  | 'events'
  | 'files'
  | 'file'
  | 'notes'
  | 'note'
  | 'git';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: SessionTreeKind,
    public readonly session: Session,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    description?: string
  ) {
    super(label, collapsible);
    this.contextValue = kind;
    if (description) this.description = description;
    this.tooltip = label;
    if (kind === 'session') {
      this.iconPath = new vscode.ThemeIcon(session.needsDescription ? 'warning' : 'check');
      this.command = {
        command: 'lalog.editSession',
        title: 'Edit session',
        arguments: [session.id],
      };
    } else if (kind === 'desc') {
      this.iconPath = new vscode.ThemeIcon('pencil');
    } else if (kind === 'time') {
      this.iconPath = new vscode.ThemeIcon('watch');
    } else if (kind === 'meta') {
      this.iconPath = new vscode.ThemeIcon('chip');
    } else if (kind === 'events') {
      this.iconPath = new vscode.ThemeIcon('symbol-event');
    } else if (kind === 'files') {
      this.iconPath = new vscode.ThemeIcon('files');
    } else if (kind === 'file') {
      this.iconPath = new vscode.ThemeIcon('file');
    } else if (kind === 'notes') {
      this.iconPath = new vscode.ThemeIcon('note');
    } else if (kind === 'note') {
      this.iconPath = new vscode.ThemeIcon('comment');
    } else if (kind === 'git') {
      this.iconPath = new vscode.ThemeIcon('git-commit');
    }
  }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private getSessions: () => Promise<Session[]>,
    private th: ThresholdsMs
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (!element) {
      const sessions = await this.getSessions();
      const byDay = new Map<string, Session[]>();
      for (const s of sessions) {
        const day = new Date(s.startedAt).toISOString().slice(0, 10);
        const list = byDay.get(day) ?? [];
        list.push(s);
        byDay.set(day, list);
      }
      const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
      return days.map(([day, list]) => {
        const total = list.reduce((sum, s) => sum + s.activeMinutes, 0);
        const n = list.length;
        return new SessionTreeItem(
          'day',
          list[0],
          `${day} — ${n} session${n > 1 ? 's' : ''}, ${fmtDuration(total)}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
      });
    }

    const s = element.session;

    if (element.kind === 'day') {
      const sessions = await this.getSessions();
      const day = new Date(s.startedAt).toISOString().slice(0, 10);
      return sessions
        .filter((x) => new Date(x.startedAt).toISOString().slice(0, 10) === day)
        .map((x) => new SessionTreeItem('session', x, formatSessionLabel(x), vscode.TreeItemCollapsibleState.Collapsed))
        .sort((a, b) => b.session.startedAt - a.session.startedAt);
    }

    if (element.kind === 'session') {
      return detailChildren(s, this.th.idleGap);
    }

    if (element.kind === 'files') {
      return (s.events?.topFiles ?? [])
        .slice()
        .sort((a, b) => b.edits - a.edits)
        .map(
          (f) =>
            new SessionTreeItem(
              'file',
              s,
              f.path,
              vscode.TreeItemCollapsibleState.None,
              `${f.edits} edit${f.edits === 1 ? '' : 's'}`
            )
        );
    }

    if (element.kind === 'notes') {
      return (s.notes ?? [])
        .slice()
        .sort((a, b) => a.at - b.at)
        .map(
          (n) =>
            new SessionTreeItem(
              'note',
              s,
              n.text,
              vscode.TreeItemCollapsibleState.None,
              formatTime(n.at)
            )
        );
    }

    return [];
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }
}

function detailChildren(s: Session, idleGapMs: number): SessionTreeItem[] {
  const items: SessionTreeItem[] = [];

  if (s.description) {
    items.push(
      new SessionTreeItem('desc', s, s.description, vscode.TreeItemCollapsibleState.None, 'description')
    );
  }

  const split = splitActiveMinutes(s, idleGapMs);
  items.push(
    new SessionTreeItem(
      'time',
      s,
      `Active ${fmtDuration(split.totalMs)}`,
      vscode.TreeItemCollapsibleState.None,
      `in VS Code ${fmtDuration(split.vscodeMs)} · outside VS Code ${fmtDuration(split.outsideMs)}`
    )
  );

  items.push(
    new SessionTreeItem(
      'meta',
      s,
      `${s.type ?? 'untagged'}${s.closedReason ? ` · ${s.closedReason}` : ''} · started ${formatTime(s.startedAt)}`,
      vscode.TreeItemCollapsibleState.None,
      s.endedAt ? `ended ${formatTime(s.endedAt)}` : 'still open'
    )
  );

  items.push(
    new SessionTreeItem(
      'events',
      s,
      formatEvents(s),
      vscode.TreeItemCollapsibleState.None
    )
  );

  const files = s.events?.topFiles ?? [];
  if (files.length) {
    items.push(
      new SessionTreeItem(
        'files',
        s,
        `${files.length} file${files.length > 1 ? 's' : ''} worked on`,
        vscode.TreeItemCollapsibleState.Collapsed
      )
    );
  }

  const notes = s.notes ?? [];
  if (notes.length) {
    items.push(
      new SessionTreeItem(
        'notes',
        s,
        `${notes.length} note${notes.length > 1 ? 's' : ''}`,
        vscode.TreeItemCollapsibleState.Collapsed
      )
    );
  }

  const commits = s.commits ?? [];
  if (s.gitBranch || commits.length) {
    items.push(
      new SessionTreeItem(
        'git',
        s,
        `git ${s.gitBranch ?? ''} · ${commits.length} commit${commits.length === 1 ? '' : 's'}`,
        vscode.TreeItemCollapsibleState.None,
        commits.length ? commits.map((c) => c.subject).join(' · ') : undefined
      )
    );
  }

  return items;
}

function formatSessionLabel(s: Session): string {
  const start = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let label = `${start} · ${s.workspaceName}`;
  if (s.description) label += ` — ${s.description}`;
  else if (s.needsDescription) label += ' — (needs description)';
  return label;
}

function formatEvents(s: Session): string {
  const e = s.events ?? { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0 };
  const parts: string[] = [];
  if (e.edits) parts.push(`${e.edits} edits`);
  if (e.saves) parts.push(`${e.saves} saves`);
  if (e.terminal) parts.push(`${e.terminal} terminal`);
  if (e.fileops) parts.push(`${e.fileops} file ops`);
  if (e.tasks) parts.push(`${e.tasks} tasks`);
  if (e.debug) parts.push(`${e.debug} debug`);
  return parts.length ? parts.join(' · ') : 'no events recorded';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], {
    month: sameDay ? undefined : 'short',
    day: sameDay ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}