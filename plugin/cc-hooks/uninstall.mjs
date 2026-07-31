#!/usr/bin/env node
// install.mjs で ~/.claude/settings.json に入れた HeadLenss フックを取り除く。
// url が /api/hooks/ を含むグループだけを各イベントから除去する (他のフックは残す)。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const settingsPath = resolve(homedir(), '.claude', 'settings.json');
const HEADLENSS_URL_RE = /\/api\/hooks\//;

function isHeadlenssGroup(g) {
  return Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.url === 'string' && HEADLENSS_URL_RE.test(h.url));
}

function uninstall() {
  if (!existsSync(settingsPath)) {
    console.log(`No settings file at ${settingsPath}; nothing to do.`);
    return;
  }
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const before = JSON.stringify(settings);
  if (settings?.hooks && typeof settings.hooks === 'object') {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((g) => !isHeadlenssGroup(g));
      if (kept.length > 0) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
  }
  if (JSON.stringify(settings) === before) {
    console.log('No HeadLenss Claude Code hooks found; nothing to remove.');
    return;
  }
  const backupPath = `${settingsPath}.bak.${Date.now()}`;
  writeFileSync(backupPath, readFileSync(settingsPath));
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Backed up to ${backupPath} and removed HeadLenss Claude Code hooks from ${settingsPath}`);
}

uninstall();
