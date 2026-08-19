// install.mjs / uninstall.mjs が共有する「このスキルは headlenss が入れたものか」の判定。
//
// マーカーは存在だけでは信用しない (破損したもの・他ツールが置いた同名ファイルを
// headlenss 由来と誤認すると、ユーザーの自作スキルを退避せずに消してしまう)。
// 中身が JSON として読めて installedBy が headlenss のものだけを自分のものとして扱う。
//
// さらに、マーカーに記録したスキル名と実際のディレクトリ名が一致することも要求する。
// インストール済みスキルを別名にコピー / 改名してカスタマイズすると、マーカーごと
// 複製されるため installedBy だけではユーザーの資産と区別が付かない。
// 名前が食い違うディレクトリは「ユーザーの資産」として扱う (uninstall では消さず、
// install で同名の正規スキルを入れるときは退避してから置き換える)。

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const MARKER_NAME = '.headlenss-skill.json';

// マーカーが headlenss 製として読めたときだけ、そこに記録されたスキル名を返す。
// (読めない・他ツールのもの・skill が文字列でない場合は null。)
export function markerSkillName(destDir) {
  const marker = join(destDir, MARKER_NAME);
  if (!existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    if (!parsed || parsed.installedBy !== 'headlenss') return null;
    return typeof parsed.skill === 'string' ? parsed.skill : null;
  } catch {
    return null;
  }
}

export function isHeadlenssSkill(destDir) {
  const name = markerSkillName(destDir);
  return name !== null && name === basename(destDir);
}
