/**
 * WASAPI 共享输出探针：BASS_Init(设备号) + ChannelPlay
 * 用法: node tools/test-wasapi-shared.js [设备号] [文件]
 */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

const NATIVE = path.join(__dirname, '..', 'native', 'win32-x64');
const bass = koffi.load(path.join(NATIVE, 'bass.dll'));

const BASS_Init = bass.func('bool __stdcall BASS_Init(int device, uint32 freq, uint32 flags, void *win, void *clsid)');
const BASS_Free = bass.func('bool __stdcall BASS_Free()');
const BASS_ErrorGetCode = bass.func('int __stdcall BASS_ErrorGetCode()');
const BASS_StreamCreateFile = bass.func('uint32 __stdcall BASS_StreamCreateFile(bool mem, void *file, int64 offset, int64 length, uint32 flags)');
const BASS_ChannelPlay = bass.func('bool __stdcall BASS_ChannelPlay(uint32 handle, bool restart)');
const BASS_ChannelIsActive = bass.func('uint32 __stdcall BASS_ChannelIsActive(uint32 handle)');
const BASS_ChannelGetInfo = bass.func('bool __stdcall BASS_ChannelGetInfo(uint32 handle, void *info)');
const BASS_ChannelGetPosition = bass.func('uint64 __stdcall BASS_ChannelGetPosition(uint32 handle, uint32 mode)');
const BASS_ChannelBytes2Seconds = bass.func('double __stdcall BASS_ChannelBytes2Seconds(uint32 handle, uint64 pos)');
const BASS_ChannelSetDevice = bass.func('bool __stdcall BASS_ChannelSetDevice(uint32 handle, uint32 device)');
const BASS_StreamFree = bass.func('bool __stdcall BASS_StreamFree(uint32 handle)');
const BASS_PluginLoad = bass.func('uint32 __stdcall BASS_PluginLoad(void *file, uint32 flags)');
const BASS_SetConfig = bass.func('bool __stdcall BASS_SetConfig(uint32 opt, uint32 value)');
const BASS_GetDevice = bass.func('uint32 __stdcall BASS_GetDevice()');

const BASS_SAMPLE_FLOAT = 256;
const BASS_UNICODE = 0x80000000;

const devIdx = Number(process.argv[2] || 2);
const trackArg = process.argv[3];

// 找一首本地歌
function findTrack(root) {
  const walk = (d, depth = 0) => {
    if (depth > 3) return null;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
      else if (/\.(flac|wav|mp3|m4a)$/i.test(e.name)) return p;
    }
    return null;
  };
  return walk(root);
}

const track = trackArg || findTrack('C:\\Users\\tianz\\OneDrive\\Music');
if (!track) { console.log('没找到测试音频'); process.exit(1); }

BASS_SetConfig(42, 1); // UNICODE
const okInit = BASS_Init(devIdx, 44100, 0, null, null);
console.log(`BASS_Init(dev=${devIdx}):`, okInit, okInit ? '' : `err=${BASS_ErrorGetCode()}`);
console.log('BASS_GetDevice():', BASS_GetDevice());
if (!okInit) process.exit(1);

const flac = path.join(NATIVE, 'bassflac.dll');
if (fs.existsSync(flac)) BASS_PluginLoad(Buffer.from(flac + '\0', 'utf16le'), BASS_UNICODE);

const chan = BASS_StreamCreateFile(false, Buffer.from(track + '\0', 'utf16le'), 0, 0, BASS_SAMPLE_FLOAT | BASS_UNICODE);
console.log('流:', chan, chan ? '' : `err=${BASS_ErrorGetCode()}`, '|', path.basename(track));
if (!chan) process.exit(1);

// 关键：把通道显式指到目标设备
const moved = BASS_ChannelSetDevice(chan, devIdx);
console.log('ChannelSetDevice:', moved, moved ? '' : `err=${BASS_ErrorGetCode()}`);

const playing = BASS_ChannelPlay(chan, false);
console.log('ChannelPlay:', playing, playing ? '' : `err=${BASS_ErrorGetCode()}`);

let last = 0;
const timer = setInterval(() => {
  const active = BASS_ChannelIsActive(chan);
  const sec = BASS_ChannelBytes2Seconds(chan, BASS_ChannelGetPosition(chan, 0));
  console.log(`  active=${active} pos=${sec.toFixed(2)}s`);
}, 1000);

setTimeout(() => {
  clearInterval(timer);
  BASS_StreamFree(chan);
  BASS_Free();
  console.log('done');
  process.exit(0);
}, 5000);
