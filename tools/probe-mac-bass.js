#!/usr/bin/env node
/**
 * macOS BASS 运行时探针 —— 在 GitHub Actions 的 mac runner 上跑。
 *
 * 本机是 Windows，mac 分支的三件事只能在真 darwin 上验：
 *   1. koffi 能否加载 native/darwin/libbass.dylib（打包进包 ≠ 运行时可加载）
 *   2. BASS_DEVICEINFO 的 24 字节布局能否正确解出 CoreAudio 设备名
 *   3. BASS_Init(-1, …) 是否被接受（-1 = 系统默认设备），HOG|FREQ 在无头环境下的表现
 *
 * 这是探针不是门禁：任何一步失败都打印原因后 exit 0，结论看 stdout。
 */
const path = require('node:path');
const fs = require('node:fs');

const W = (...a) => console.log(...a);
W('=== mac BASS 探针 ===');
W('platform =', process.platform, '| arch =', process.arch, '| node =', process.version);

const NATIVE = path.join(__dirname, '..', 'native', 'darwin');
const LIB = path.join(NATIVE, 'libbass.dylib');
W('dylib =', LIB, '| exists =', fs.existsSync(LIB));
if (!fs.existsSync(LIB)) { W('结论：dylib 不在包里（打包漏了）'); process.exit(0); }

let koffi, bass;
try {
  koffi = require('koffi');
  W('koffi 已加载');
} catch (e) {
  W('结论：koffi 无法在 darwin 上加载 →', e.message);
  process.exit(0);
}
try {
  bass = koffi.load(LIB);
  W('koffi.load(libbass.dylib) = OK');
} catch (e) {
  W('结论：dylib 加载失败 →', e.message);
  process.exit(0);
}

const DEVINFO = koffi.struct('BASS_DEVICEINFO_PROBE', {
  name: 'const char *',
  driver: 'const char *',
  flags: 'uint32'
});

const BASS_Init = bass.func('int BASS_Init(int device, uint32 freq, uint32 flags, void *win, void *proc)');
const BASS_Free = bass.func('int BASS_Free()');
const BASS_ErrorGetCode = bass.func('int BASS_ErrorGetCode()');
const BASS_SetConfig = bass.func('int BASS_SetConfig(uint32 option, uint32 value)');
const BASS_GetDeviceInfo = bass.func('int BASS_GetDeviceInfo(uint32 device, _Out_ BASS_DEVICEINFO_PROBE *info)');

W('sizeof(BASS_DEVICEINFO) =', koffi.sizeof(DEVINFO));

// ── 1. 枚举（不需要 Init）──
W('\n--- 设备枚举 ---');
try { BASS_SetConfig(42, 0); } catch {}
for (let i = 0; i <= 10; i++) {
  const o = {};
  let ok = 0;
  try { ok = BASS_GetDeviceInfo(i, o); } catch (e) { W(`dev=${i} 调用异常: ${e.message}`); break; }
  if (!ok) { W(`dev=${i} 无（枚举结束）err=${BASS_ErrorGetCode()}`); break; }
  const f = (o.flags || 0) >>> 0;
  W(`dev=${i} ok name="${o.name || ''}" driver="${o.driver || ''}" flags=0x${f.toString(16)}` +
    ` ${f & 1 ? '[enabled]' : '[disabled]'} ${f & 2 ? '[default]' : ''}`);
}

// ── 2. Init(-1)：-1 是 BASS 惯用法的系统默认设备 ──
function tryInit(label, dev, freq, flags) {
  W(`\n--- ${label}: BASS_Init(${dev}, ${freq}, 0x${flags.toString(16)}) ---`);
  let ok = 0;
  try { ok = BASS_Init(dev, freq, flags, null, null); }
  catch (e) { W('异常:', e.message); return; }
  W('返回值 =', ok, ok ? 'OK' : `失败 err=${BASS_ErrorGetCode()}`);
  if (ok) { try { BASS_Free(); } catch (e) { W('Free 异常:', e.message); } W('已 BASS_Free'); }
}

try { BASS_SetConfig(42, 0); } catch {}
tryInit('默认设备（-1，无 HOG）', -1, 48000, 0);
tryInit('默认设备（-1，HOG|FREQ，44.1k）', -1, 44100, 0x10000 | 0x8000);
tryInit('设备 1（-，无 HOG）', 1, 48000, 0);
tryInit('设备 1（HOG|FREQ，48k）', 1, 48000, 0x10000 | 0x8000);

W('\n=== 探针结束 ===');
process.exit(0);
