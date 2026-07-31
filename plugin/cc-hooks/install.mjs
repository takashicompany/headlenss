#!/usr/bin/env node
// HeadLenss の Claude Code フックを ~/.claude/settings.json に直接インストールする。
// `/plugin install headlenss@headlenss` (対話コマンド) の代わりに、セットアップ時に
// スクリプトで入れられるようにするためのもの (codex-hooks/install.mjs と対称)。
//
// フック定義は plugin/hooks/hooks.json をそのまま流用する (settings.json は plugin と
// 同一の hook 形式 = type:"http" を受け付ける)。冪等: 既存の HeadLenss フックは入れ直す。
//
// サーバが http://localhost:3000 でない場合は HEADLENSS_SERVER_URL で上書きできる。
//   例: HEADLENSS_SERVER_URL=http://ubook:3000 node plugin/cc-hooks/install.mjs
//
// ⚠ 注意: マーケットプレイス版 (/plugin install) と併用すると hook が二重発火する。
//   どちらか一方にすること。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginHooksPath = resolve(__dirname, '..', 'hooks', 'hooks.json');
const claudeDir = resolve(homedir(), '.claude');
const settingsPath = resolve(claudeDir, 'settings.json');

const DEFAULT_BASE = 'http://localhost:3000';
const serverUrl = (process.env.HEADLENSS_SERVER_URL || DEFAULT_BASE).replace(/\/+$/, '');

// HeadLenss のフックかどうかは url が /api/hooks/ を含むかで判定する。
const HEADLENSS_URL_RE = /\/api\/hooks\//;

function loadPluginHooks() {
  const parsed = JSON.parse(readFileSync(pluginHooksPath, 'utf8'));
  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== 'object') throw new Error(`no "hooks" object in ${pluginHooksPath}`);
  if (serverUrl !== DEFAULT_BASE) {
    for (const groups of Object.values(hooks)) {
      for (const g of groups) {
        for (const h of g?.hooks ?? []) {
          if (typeof h.url === 'string') h.url = h.url.replace(DEFAULT_BASE, serverUrl);
        }
      }
    }
  }
  return hooks;
}

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('root is not an object');
    return parsed;
  } catch (err) {
    throw new Error(`failed to parse ${settingsPath}: ${err.message}`);
  }
}

function isHeadlenssGroup(g) {
  return Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.url === 'string' && HEADLENSS_URL_RE.test(h.url));
}

function install() {
  const pluginHooks = loadPluginHooks();
  const settings = readSettings();
  const before = JSON.stringify(settings);
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  for (const [event, groups] of Object.entries(pluginHooks)) {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // 既存の HeadLenss グループを除去してから入れ直す (冪等 + url 変更時の更新)。
    const kept = current.filter((g) => !isHeadlenssGroup(g));
    settings.hooks[event] = [...kept, ...groups];
  }

  if (JSON.stringify(settings) === before) {
    console.log(`HeadLenss Claude Code hooks already installed in ${settingsPath} (server: ${serverUrl})`);
    return;
  }

  mkdirSync(claudeDir, { recursive: true });
  if (existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.bak.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(settingsPath));
    console.log(`Backed up existing settings to ${backupPath}`);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Installed HeadLenss Claude Code hooks to ${settingsPath} (server: ${serverUrl})`);
  console.log('Restart Claude Code, run /hooks, then review and trust the HeadLenss hooks once.');
}

install();
