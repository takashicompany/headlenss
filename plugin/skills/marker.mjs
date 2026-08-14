// install.mjs / uninstall.mjs が共有する「このスキルは headlenss が入れたものか」の判定。
//
// マーカーは存在だけでは信用しない (破損したもの・他ツールが置いた同名ファイルを
// headlenss 由来と誤認すると、ユーザーの自作スキルを退避せずに消してしまう)。
// 中身が JSON として読めて installedBy が headlenss のものだけを自分のものとして扱う。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARKER_NAME = '.headlenss-skill.json';

export function isHeadlenssSkill(destDir) {
  const marker = join(destDir, MARKER_NAME);
  if (!existsSync(marker)) return false;
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    return Boolean(parsed) && parsed.installedBy === 'headlenss';
  } catch {
    return false;
  }
}
