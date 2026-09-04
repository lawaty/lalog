import * as vscode from 'vscode';
import * as path from 'path';
import { Session } from '../core/types';
import { fmtDuration } from '../prompts/promptCoordinator';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    public readonly kind: 'session' | 'day' | 'backlog-root',
    label: string,
    collapsible: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsible);
    this.contextValue = kind;
    if (kind === 'session') {
      this.iconPath = new vscode.ThemeIcon(session.needsDescription ? 'warning' : 'check');
      this.description =
        fmtDuration(session.activeMinutes) +
        (session.type ? ` · ${session.type}` : '');
      this.command = {
        command: 'lalog.editSession',
        title: 'Edit session',
        arguments: [session.id],
      };
    }
  }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private getSessions: () => Promise<Session[]>) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (!element) {
      const sessions = await this.getSessions();
      // Group by start-date-day (display index only), sessions newer first.
      const byDay = new Map<string, Session[]>();
      for (const s of sessions) {
        const d = new Date(s.startedAt);
        const label = d.toISOString().slice(0, 10);
        const day = (byDay.get(label) ?? []);
        day.push(s);
        byDay.set(label, day);
      }
      const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
      return days.map(([day, list]) => {
        const total = list.reduce((sum, s) => sum + s.activeMinutes, 0);
        const n = list.length;
        return new SessionTreeItem(
          list[0],
          'day',
          `${day} — ${n} session${n > 1 ? 's' : ''}, ${fmtDuration(total)}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
      });
    }
    if (element.kind === 'day') {
      const sessions = await this.getSessions();
      const day = new Date(element.session.startedAt).toISOString().slice(0, 10);
      return sessions
        .filter((s) => new Date(s.startedAt).toISOString().slice(0, 10) === day)
        .map((s) => new SessionTreeItem(s, 'session', formatSessionLabel(s), vscode.TreeItemCollapsibleState.None))
        .sort((a, b) => b.session.startedAt - a.session.startedAt);
    }
    return [];
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }
}

function formatSessionLabel(s: Session): string {
  const start = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let label = `${start} · ${s.workspaceName}`;
  if (s.description) label += ` — ${s.description}`;
  else if (s.needsDescription) label += ' — (needs description)';
  return label;
}
