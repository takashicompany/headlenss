#!/usr/bin/env node
// HeadLenss 同梱の Claude Code スキルを ~/.claude/skills/<name>/ にインストールする。
// リポジトリを消しても壊れないよう、シンボリックリンクではなく「コピー」する
// (cc-hooks/install.mjs, codex-hooks/install.mjs と対称のセットアップスクリプト)。
//
// 対象は plugin/skills/ 直下で SKILL.md を持つディレクトリすべて。
// 冪等: 中身が同じなら何もしない。違えば入れ直す。
//
// インストールしたディレクトリには .headlenss-skill.json (マーカー) を置く。
// uninstall.mjs はこのマーカーがあるものだけを消すので、同名の自作スキルは巻き込まない。
//
// スキル本文に書かれた headlenss サーバの API ベース URL は HEADLENSS_SERVER_URL で
// 差し替えられる。
//   例: HEADLENSS_SERVER_URL=http://my-pc:3000 node plugin/skills/install.mjs
// 差し替えるのは「API のベースとして使われている箇所」(直後に /api が続くもの) だけ。
// tailscale serve のバックエンド指定のように、ループバックのまま残さないと壊れる記述が
// 本文にあるため、URL 文字列を無差別に置換しない。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = __dirname;
const skillsDir = resolve(homedir(), '.claude', 'skills');
// 退避先は skills/ の外に置く (中に置くと Claude Code が重複スキルとして読み込んでしまう)。
const backupRoot = resolve(homedir(), '.claude', 'skills-backup');

const MARKER_NAME = '.headlenss-skill.json';
const DEFAULT_BASES = ['http://127.0.0.1:3000', 'http://localhost:3000'];
// API ベースとしての使用箇所 (直後に /api が続くもの) だけを差し替える。
// 例: http://127.0.0.1:3000/api/health -> <HEADLENSS_SERVER_URL>/api/health
//     sudo tailscale serve --https=443 --bg http://127.0.0.1:3000  (← 置換しない)
const API_BASE_RE = /http:\/\/(?:127\.0\.0\.1|localhost):3000(?=\/api\b)/g;
// 置換してはいけない行の目印 (tailscale のバックエンドは必ずループバック)。
const LOOPBACK_ONLY_HINTS = ['tailscale serve', '/ proxy '];

const rawServerUrl = (process.env.HEADLENSS_SERVER_URL || '').replace(/\/+$/, '');
// 既定値と同じ URL を渡された場合は置換不要 (下の検証も誤検知するのでここで落とす)。
const serverUrl = DEFAULT_BASES.includes(rawServerUrl) ? '' : rawServerUrl;

// SKILL.md 等の本文だけ URL を差し替える (バイナリ資材はそのままコピー)。
function renderText(text, label) {
  if (!serverUrl) return text;
  const out = text.replace(API_BASE_RE, serverUrl);
  assertLoopbackKept(out, label);
  return out;
}

// tailscale serve のバックエンド等、ループバックのまま残すべき行に
// 差し替え後の URL が混入していないことを確認する (混入するとプロキシがループする)。
function assertLoopbackKept(text, label) {
  const bad = text
    .split('\n')
    .filter((line) => line.includes(serverUrl) && LOOPBACK_ONLY_HINTS.some((hint) => line.includes(hint)));
  if (bad.length === 0) return;
  throw new Error(
    `${label || 'skill text'}: ${serverUrl} が loopback 固定の行に混入しました。` +
      `該当行:\n${bad.map((l) => `  ${l.trim()}`).join('\n')}`,
  );
}

function isText(name) {
  return /\.(md|markdown|txt)$/i.test(name);
}

function listSkills() {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(sourceRoot, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

// ディレクトリを「レンダリング後の内容」で比較するため、相対パス -> Buffer の一覧にする。
function collectFiles(dir, render, base = dir, acc = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const rel = full.slice(base.length + 1);
    if (entry.isDirectory()) {
      collectFiles(full, render, base, acc);
    } else if (entry.isFile()) {
      const buf = readFileSync(full);
      acc.set(rel, render && isText(entry.name) ? Buffer.from(renderText(buf.toString('utf8'), full)) : buf);
    }
  }
  return acc;
}

// want は collectFiles(sourceDir, true) の結果 (= レンダリング後の期待内容)。
function sameContent(want, destDir) {
  if (!existsSync(destDir)) return false;
  const have = collectFiles(destDir, false);
  have.delete(MARKER_NAME);
  if (want.size !== have.size) return false;
  for (const [rel, buf] of want) {
    const other = have.get(rel);
    if (!other || !other.equals(buf)) return false;
  }
  return true;
}

function copySkill(want, sourceDir, destDir, name) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const [rel, buf] of want) {
    const target = join(destDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
  }
  const marker = {
    installedBy: 'headlenss',
    skill: name,
    source: sourceDir,
    installedAt: new Date().toISOString(),
    ...(serverUrl ? { serverUrl } : {}),
  };
  writeFileSync(join(destDir, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);
}

function install() {
  const names = listSkills();
  if (names.length === 0) {
    console.log(`No skills found under ${sourceRoot}; nothing to install.`);
    return;
  }

  mkdirSync(skillsDir, { recursive: true });
  let changed = 0;

  for (const name of names) {
    const sourceDir = join(sourceRoot, name);
    const destDir = join(skillsDir, name);
    const marker = join(destDir, MARKER_NAME);

    if (existsSync(destDir) && !statSync(destDir).isDirectory()) {
      throw new Error(`${destDir} exists but is not a directory; move it away and retry.`);
    }

    // ソースは 1 スキルにつき 1 回だけ読む (比較にも書き込みにも同じ結果を使う)。
    const want = collectFiles(sourceDir, true);

    // 安いマーカー確認を先に済ませてから、内容比較を行う。
    if (existsSync(marker) && sameContent(want, destDir)) {
      console.log(`HeadLenss skill "${name}" is already installed in ${destDir}`);
      continue;
    }

    if (existsSync(destDir)) {
      if (existsSync(marker)) {
        console.log(`Updating existing HeadLenss skill at ${destDir}`);
      } else {
        // このリポジトリ由来でない同名スキルは、消す前に必ず退避する。
        const backupPath = join(backupRoot, `${name}.bak.${Date.now()}`);
        mkdirSync(backupRoot, { recursive: true });
        cpSync(destDir, backupPath, { recursive: true });
        console.log(`Backed up existing skill to ${backupPath}`);
      }
    }

    copySkill(want, sourceDir, destDir, name);
    console.log(`Installed HeadLenss skill "${name}" to ${destDir}`);
    changed += 1;
  }

  if (changed === 0) {
    console.log(`All HeadLenss skills are up to date in ${skillsDir}`);
    return;
  }
  if (serverUrl) console.log(`Server URL in the skill text was set to ${serverUrl}`);
  console.log('Restart Claude Code (or run /doctor) so the new skills are picked up.');
}

install();
