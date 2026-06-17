#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = resolve(__dirname, 'headlenss-codex-hook.mjs');
const codexDir = resolve(homedir(), '.codex');
const hooksPath = resolve(codexDir, 'hooks.json');
const command = `node ${JSON.stringify(hookScript)}`;

const HEADLENSS_HOOKS = {
  SessionStart: [
    {
      matcher: 'startup|resume',
      hooks: [
        {
          type: 'command',
          command,
          timeout: 10,
          statusMessage: 'Registering headlenss session',
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [{ type: 'command', command, timeout: 10 }],
    },
  ],
  Stop: [
    {
      hooks: [{ type: 'command', command, timeout: 30 }],
    },
  ],
  PreToolUse: [
    {
      matcher: '*',
      hooks: [{ type: 'command', command, timeout: 10 }],
    },
  ],
  PostToolUse: [
    {
      matcher: '*',
      hooks: [{ type: 'command', command, timeout: 10 }],
    },
  ],
  PermissionRequest: [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command,
          timeout: 10,
          statusMessage: 'Notifying headlenss',
        },
      ],
    },
  ],
};

function readExisting() {
  if (!existsSync(hooksPath)) return { hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('root is not an object');
    if (!parsed.hooks || typeof parsed.hooks !== 'object') parsed.hooks = {};
    return parsed;
  } catch (err) {
    throw new Error(`failed to parse ${hooksPath}: ${err.message}`);
  }
}

function hasHeadlenssHook(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => h?.command === command);
}

function install() {
  mkdirSync(codexDir, { recursive: true });
  const config = readExisting();
  let changed = false;

  for (const [event, groups] of Object.entries(HEADLENSS_HOOKS)) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    for (const group of groups) {
      if (!current.some(hasHeadlenssHook)) {
        current.push(group);
        changed = true;
      }
    }
    config.hooks[event] = current;
  }

  if (!changed) {
    console.log(`HeadLenss Codex hooks are already installed in ${hooksPath}`);
    return;
  }

  if (existsSync(hooksPath)) {
    const backupPath = `${hooksPath}.bak.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(hooksPath));
    console.log(`Backed up existing hooks to ${backupPath}`);
  }

  writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Installed HeadLenss Codex hooks to ${hooksPath}`);
  console.log('Restart Codex, run /hooks, then review and trust the HeadLenss hooks once.');
}

install();
