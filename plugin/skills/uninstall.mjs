#!/usr/bin/env node
// install.mjs で ~/.claude/skills/ に入れた HeadLenss スキルを取り除く。
// .headlenss-skill.json (インストーラが置くマーカー) の中身が headlenss 製で、かつ
// 記録されたスキル名がディレクトリ名と一致するものだけを消す。
// 同名の自作スキルや、別名にコピー / 改名したカスタマイズ版は消さずに理由を出して残す。
//
// 削除対象はリポジトリの現在のファイル一覧ではなく ~/.claude/skills/ 側の走査で決める。
// (スキルを削除・改名しても、旧バージョンでインストールしたものが取り残されないため。)

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// マーカーの中身まで見る判定 (install.mjs と共通)。
import { isHeadlenssSkill, markerSkillName } from './marker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = __dirname;
const skillsDir = resolve(homedir(), '.claude', 'skills');

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
      // HeadLenss が入れたと確認できないディレクトリには触れない。
      const claimed = markerSkillName(destDir);
      if (claimed !== null) {
        // マーカーはあるが、記録されたスキル名とディレクトリ名が違う。
        // インストール済みスキルを別名でコピー / 改名したもの (= ユーザーの資産) と見なす。
        console.log(`Skipped ${destDir} (copied or renamed from HeadLenss skill "${claimed}"; treated as your own and left untouched)`);
      } else if (fromRepo.has(entry.name)) {
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
