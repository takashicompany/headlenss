#!/usr/bin/env node
const EVENT_TO_PATH = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  Stop: 'stop',
  PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use',
  PermissionRequest: 'permission-request',
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function empty() {
  process.stdout.write('{}\n');
}

try {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  payload.source = payload.source ?? 'codex';
  const event = payload.hook_event_name;
  const path = EVENT_TO_PATH[event];
  if (!path) {
    empty();
    process.exit(0);
  }

  const base = (process.env.HEADLENSS_SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
  const res = await fetch(base + '/api/hooks/codex/' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tmux-Pane': process.env.TMUX_PANE || '',
      'X-Tmux': process.env.TMUX || '',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error('[headlenss-codex-hook] server HTTP ' + res.status);
    empty();
    process.exit(0);
  }
  const text = (await res.text()).trim();
  process.stdout.write((text || '{}') + '\n');
} catch (err) {
  console.error('[headlenss-codex-hook] ' + (err && err.message ? err.message : String(err)));
  empty();
}
