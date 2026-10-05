// src/core/ が決定性のルール(CLAUDE.md「絶対に守ること」)を守っているかを機械的に検査する
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE = join(__dirname, '..', 'src', 'core');

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** IEEE 754で結果が一意に決まる、またはビット演算の Math 関数だけを許可する */
const ALLOWED_MATH = new Set([
  'PI', 'abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'sqrt', 'imul', 'fround', 'clz32',
]);

const FORBIDDEN: [RegExp, string][] = [
  [/from\s+['"]three['"]|from\s+['"]three\//, 'three を import している'],
  [/from\s+['"]react/, 'React を import している'],
  [/\b(window|document|localStorage|indexedDB|navigator|performance)\./, 'DOM・ブラウザAPIを参照している'],
  [/\bDate\.now\(|new Date\(/, '時刻を参照している'],
];

describe('core/ の決定性ルール', () => {
  const files = listFiles(CORE);

  it('検査対象のファイルがある', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(relative(CORE, file), () => {
      // コメントは検査対象外にする
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const problems: string[] = [];
      for (const m of src.matchAll(/\bMath\.(\w+)/g)) {
        if (!ALLOWED_MATH.has(m[1])) problems.push(`Math.${m[1]} は禁止(core/math/ の関数を使う)`);
      }
      for (const [re, msg] of FORBIDDEN) if (re.test(src)) problems.push(msg);
      expect(problems).toEqual([]);
    });
  }
});
