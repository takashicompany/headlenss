#!/usr/bin/env node
// install.mjs で ~/.claude/skills/ に入れた HeadLenss スキルを取り除く。
// .headlenss-skill.json (インストーラが置くマーカー) があるディレクトリだけを消す。
// 同名の自作スキルは消さずに警告して残す。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = __dirname;
const skillsDir = resolve(homedir(), '.claude', 'skills');

const MARKER_NAME = '.headlenss-skill.json';

function listSkills() {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(sourceRoot, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

function uninstall() {
  if (!existsSync(skillsDir)) {
    console.log(`No skills directory at ${skillsDir}; nothing to do.`);
    return;
  }

  let removed = 0;
  for (const name of listSkills()) {
    const destDir = join(skillsDir, name);
    if (!existsSync(destDir) || !statSync(destDir).isDirectory()) continue;
    if (!existsSync(join(destDir, MARKER_NAME))) {
      console.log(`Skipped ${destDir} (not installed by HeadLenss; left untouched)`);
      continue;
    }
    rmSync(destDir, { recursive: true, force: true });
    console.log(`Removed HeadLenss skill "${name}" from ${destDir}`);
    removed += 1;
  }

  if (removed === 0) {
    console.log(`No HeadLenss skills found in ${skillsDir}; nothing to remove.`);
    return;
  }
  console.log('Restart Claude Code so the removed skills disappear.');
}

uninstall();
