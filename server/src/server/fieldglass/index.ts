import type { Hono } from 'hono';
import * as claudeStore from '../claude/store.ts';
import { createFieldglassModule } from './router.ts';
import { FieldglassError } from './validation.ts';
import { listSessions } from '../tmux.ts';

type MountOptions = Omit<Parameters<typeof createFieldglassModule>[0], 'sendPrompt'> & {
  listSessions?: () => Promise<ReadonlyArray<{ name: string }>>;
};

/** Mount only: reuse the existing in-process HTTP input handler, including its
 * tmux mutex and delivery tracking. Never bypass it with direct key injection. */
export function mountFieldglass(app: Hono, options: MountOptions = {}) {
  const { listSessions: liveSessions = listSessions, ...moduleOptions } = options;
  const fieldglass = createFieldglassModule({
    ...moduleOptions,
    sendPrompt: async (session, prompt) => {
      const response = await app.request('/api/claude/sessions');
      if (!response.ok) throw new FieldglassError('Could not verify the selected session', 502);
      const body = await response.json() as { sessions?: { tmuxSessionName: string; source?: string; status: string; screenBlocked?: boolean }[] };
      const target = body.sessions?.find((item) => item.tmuxSessionName === session);
      if (!target || target.source !== 'claude') throw new FieldglassError('Choose an active Claude session', 404);
      if (target.screenBlocked || target.status === 'waiting-permission' || target.status === 'waiting-question' || claudeStore.getPending(session)) {
        throw new FieldglassError('Resolve the session’s existing question or permission request first', 409);
      }
      // The Claude endpoint can retain tracked entries when tmux discovery
      // fails. Require exact live membership too; never rely on tmux's prefix
      // target matching to decide where a saved quote should be sent.
      const live = await liveSessions().catch(() => { throw new FieldglassError('Could not verify the live tmux session list', 502); });
      if (!live.some((item) => item.name === session)) throw new FieldglassError('The selected tmux session is no longer active', 404);
      const input = await app.request(`/api/sessions/${encodeURIComponent(session)}/input`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: prompt, submit: true }),
      });
      if (!input.ok) {
        throw new FieldglassError('Handoff could not be confirmed. Check the selected session before retrying.', input.status === 409 ? 409 : 502);
      }
    },
  });
  app.route('/api/fieldglass', fieldglass.router);
  fieldglass.start();
  const stop = () => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    fieldglass.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { ...fieldglass, stop };
}
