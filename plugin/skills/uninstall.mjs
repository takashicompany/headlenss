#!/usr/bin/env node
// install.mjs で ~/.claude/skills/ に入れた HeadLenss スキルを取り除く。
// .headlenss-skill.json (インストーラが置くマーカー) があるディレクトリだけを消す。
// 同名の自作スキルは消さずに警告して残す。
//
// 削除対象はリポジトリの現在のファイル一覧ではなく ~/.claude/skills/ 側の走査で決める。
// (スキルを削除・改名しても、旧バージョンでインストールしたものが取り残されないため。)

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = __dirname;
const skillsDir = resolve(homedir(), '.claude', 'skills');

const MARKER_NAME = '.headlenss-skill.json';

// マーカーの中身まで見る (たまたま同名のファイルがあるだけのものを消さない)。
function isHeadlenssSkill(destDir) {
  const marker = join(destDir, MARKER_NAME);
  if (!existsSync(marker)) return false;
  try {
    return JSON.parse(readFileSync(marker, 'utf8')).installedBy === 'headlenss';
  } catch {
    return false;
  }
}

// 「同名の自作スキルを残した」旨を伝えるためだけに使う (削除判定には使わない)。
function repoSkillNames() {
  if (!existsSync(sourceRoot)) return new Set();
  return new Set(
    readdirSync(sourceRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(sourceRoot, e.name, 'SKILL.md')))
      .map((e) => e.name),
  );
}

function uninstall() {
  if (!existsSync(skillsDir)) {
    console.log(`No skills directory at ${skillsDir}; nothing to do.`);
    return;
  }

  const fromRepo = repoSkillNames();
  let removed = 0;

  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const destDir = join(skillsDir, entry.name);

    if (!isHeadlenssSkill(destDir)) {
      // マーカーが無い (= HeadLenss が入れたものではない) ディレクトリには触れない。
      if (fromRepo.has(entry.name)) {
        console.log(`Skipped ${destDir} (not installed by HeadLenss; left untouched)`);
      }
      continue;
    }

    rmSync(destDir, { recursive: true, force: true });
    console.log(`Removed HeadLenss skill "${entry.name}" from ${destDir}`);
    removed += 1;
  }

  if (removed === 0) {
    console.log(`No HeadLenss skills found in ${skillsDir}; nothing to remove.`);
    return;
  }
  console.log('Restart Claude Code so the removed skills disappear.');
}

uninstall();
