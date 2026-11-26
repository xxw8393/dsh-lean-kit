#!/usr/bin/env node
// 升级预检：preset 里每个 `name:` 是否仍能被当前 DSH 宿主解析。
// 宿主把内部插件当私有结构滚动改造（合并/改名/删子路径），升级后单条失效就会让
// 整个 preset 判 invalid（新建会话直接失败）。用法：
//   node check-preset.mjs [cordis.patch.yml] [app.asar 路径]
// 退出码 1 = 有无法解析的条目。
import fs from 'node:fs';
import path from 'node:path';

const presetFile = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'cordis.patch.yml');
const asarPath = process.argv[3] || process.env.DSH_ASAR || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const hb = Buffer.alloc(jsonLen);
fs.readSync(fd, hb, 0, jsonLen, 16);
const header = JSON.parse(hb.toString('utf8'));
const base = 16 + Math.ceil(jsonLen / 4) * 4;

function nodeAt(p) {
  let n = header;
  for (const seg of p.split('/').filter(Boolean)) {
    if (!n.files || !n.files[seg]) return null;
    n = n.files[seg];
  }
  return n;
}
const read = (p) => {
  const n = nodeAt(p);
  if (!n || n.files) return null;
  const buf = Buffer.alloc(n.size);
  fs.readSync(fd, buf, 0, n.size, base + parseInt(n.offset, 10));
  return buf.toString('utf8');
};
const pkgExists = (name) => !!nodeAt(`dsh/node_modules/${name}`);

const names = [...fs.readFileSync(presetFile, 'utf8').matchAll(/name:\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1].trim());
let fail = 0;
for (const n of new Set(names)) {
  if (!n.startsWith('@')) continue; // cordis:group / 本地相对插件自行确认
  const m = n.match(/^(@[^/]+\/[^/]+)(\/.*)?$/);
  if (!m) continue;
  const [, pkg, sub] = m;
  if (!pkgExists(pkg)) { console.log(`FAIL  ${n}  [包不存在]`); fail++; continue; }
  if (!sub) continue;
  const pj = JSON.parse(read(`dsh/node_modules/${pkg}/package.json`) || '{}');
  const key = '.' + sub;
  const exported = pj.exports && (pj.exports[key] !== undefined || pj.exports[sub.slice(1)] !== undefined);
  const fileExists = !!read(`dsh/node_modules/${pkg}/${sub.replace(/^\//, '')}.js`);
  if (!exported && !fileExists) { console.log(`FAIL  ${n}  [子路径导出已删除]`); fail++; }
}
console.log(fail === 0 ? `OK    全部 ${new Set(names).size} 个 name 可解析：${presetFile}` : `${fail} 条无法解析 → 该 preset 会判 invalid`);
process.exit(fail === 0 ? 0 : 1);
