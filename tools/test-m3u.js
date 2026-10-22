/** 独立验证 m3u 解析逻辑（和 app/main.js 里的 parseM3uFile 一致） */
const fs = require('fs');
const path = require('path');

function parseM3uFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const base = path.dirname(file);
  const out = [];
  const seen = new Set();

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) { console.log('  跳过网络地址:', line); continue; }

    if (line.startsWith('file:///')) {
      try { line = decodeURIComponent(line.slice(8)); } catch {}
    }
    line = line.replace(/\//g, path.sep);

    const abs = path.isAbsolute(line) ? line : path.resolve(base, line);
    if (seen.has(abs)) { console.log('  跳过重复:', path.basename(abs)); continue; }
    seen.add(abs);
    if (fs.existsSync(abs)) out.push(abs);
    else console.log('  跳过不存在:', path.basename(abs));
  }
  return out;
}

const target = process.argv[2];
const list = parseM3uFile(target);
console.log(`\n有效条目 ${list.length} 个：`);
list.forEach((x) => console.log('  ✓', path.basename(x)));
