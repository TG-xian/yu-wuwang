/**
 * 用 BASS 主库枚举输出设备，找 WASAPI 设备
 * BASS_DEVICEINFO { char *name; char *driver; DWORD flags; }
 */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

const NATIVE = path.join(__dirname, '..', 'native', 'win32-x64');
const bass = koffi.load(path.join(NATIVE, 'bass.dll'));

const BASS_GetDeviceInfo = bass.func('int __stdcall BASS_GetDeviceInfo(uint32 device, void *info)');
const BASS_ErrorGetCode = bass.func('int __stdcall BASS_ErrorGetCode()');
const BASS_SetConfig = bass.func('bool __stdcall BASS_SetConfig(uint32 opt, uint32 value)');
const BASS_GetVersion = bass.func('uint32 __stdcall BASS_GetVersion()');

BASS_SetConfig(42, 1); // UNICODE

const v = BASS_GetVersion();
console.log('bass:', `${v >>> 16}.${v & 0xffff}`);

function readCStr(ptr, unicode) {
  if (!ptr) return '';
  try {
    const bytes = koffi.decode(ptr, 'uint8', unicode ? 1024 : 512);
    const buf = Buffer.from(bytes);
    if (unicode) return buf.toString('utf16le').split('\0')[0];
    // 主体是 UTF-8（实测），纯 ASCII 两种情况一致
    const u8 = buf.toString('utf8').split('\0')[0];
    return u8;
  } catch (e) { return `<err ${e.message}>`; }
}

console.log('\n=== BASS 输出设备 ===');
for (let i = 0; i < 32; i++) {
  const p = koffi.alloc('uint8', 64);
  const ok = BASS_GetDeviceInfo(i, p);
  if (ok === 0) break;
  const buf = Buffer.from(koffi.decode(p, 'uint8', 64));
  const namePtr = koffi.decode(buf, 0, 'void*');
  const drvPtr = koffi.decode(buf, 8, 'void*');
  const flags = buf.readUInt32LE(16);
  const nameU = readCStr(namePtr, false);   // 实测是 ANSI，不是 UTF-16
  const drvU = readCStr(drvPtr, false);
  const f = [];
  if (flags & 1) f.push('ENABLED');
  if (flags & 2) f.push('DEFAULT');
  if (flags & 4) f.push('INIT');
  if (flags & 8) f.push('8BITS');
  if (flags & 0x10) f.push('MONO');
  if (flags & 0x80000000) f.push('NET');
  console.log(`[${i}] name=${JSON.stringify(nameU)} driver=${JSON.stringify(drvU)} (${f.join('|')||flags})`);
}
if (BASS_GetDeviceInfo(0, koffi.alloc('uint8', 64)) === 0 && BASS_GetDeviceInfo(1, koffi.alloc('uint8', 64)) === 0) {
  console.log('（没有任何设备，可能 BASS 未初始化——这是正常的，BASS_GetDeviceInfo 不需要 Init）');
}
