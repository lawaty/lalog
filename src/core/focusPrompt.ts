import type { Session, SessionState } from './types';

/**
 * Decide whether losing the window's focus should offer the optional
 * description right now. VS Code exposes no stable pre-shutdown hook (the
 * only candidate, `workspace.onWillShutdown`, is a proposed API), so a
 * focus-loss event is the closest approximation to "ask before exiting".
 * To avoid nagging, only sessions that are already due-for-a-description
 * prompt — a quick alt-tab to another app never triggers this.
 */
export function shouldPromptOnFocusLost(
  session: Session | null,
  state: SessionState,
  alreadyPrompted: boolean
): boolean {
  if (!session || alreadyPrompted) return false;
  if (session.anonymous || session.description) return false;
  return state === 'describePending';
}