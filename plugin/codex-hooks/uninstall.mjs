#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = resolve(__dirname, 'headlenss-codex-hook.mjs');
const codexDir = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'));
const hooksPath = resolve(codexDir, 'hooks.json');
const baseCommand = `node ${JSON.stringify(hookScript)}`;

function isHeadlenssHook(hook) {
  if (typeof hook?.command !== 'string') return false;
  // Accept a bare command or one URL assignment, including quoted/escaped values.
  const withoutServerUrl = hook.command.replace(
    /^HEADLENSS_SERVER_URL=(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|[^\s'"\\;&|<>()`])*[ \t]+/,
    '',
  );
  return withoutServerUrl === baseCommand;
}

if (!existsSync(hooksPath)) {
  console.log(`${hooksPath} does not exist; nothing to uninstall.`);
  process.exit(0);
}

const config = JSON.parse(readFileSync(hooksPath, 'utf8'));
if (!config?.hooks || typeof config.hooks !== 'object') {
  console.log(`${hooksPath} has no hooks object; nothing to uninstall.`);
  process.exit(0);
}

let removed = 0;
for (const [event, groups] of Object.entries(config.hooks)) {
  if (!Array.isArray(groups)) continue;
  const nextGroups = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const nextHooks = group.hooks.filter((h) => {
      const keep = !isHeadlenssHook(h);
      if (!keep) removed += 1;
      return keep;
    });
    if (nextHooks.length > 0) nextGroups.push({ ...group, hooks: nextHooks });
  }
  if (nextGroups.length > 0) config.hooks[event] = nextGroups;
  else delete config.hooks[event];
}

if (removed === 0) {
  console.log(`No HeadLenss Codex hooks found in ${hooksPath}`);
  process.exit(0);
}

const backupPath = `${hooksPath}.bak.${Date.now()}`;
writeFileSync(backupPath, readFileSync(hooksPath));
writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Removed ${removed} HeadLenss Codex hook command(s) from ${hooksPath}`);
console.log(`Backed up previous hooks to ${backupPath}`);
