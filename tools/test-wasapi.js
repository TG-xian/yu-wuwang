/**
 * WASAPI 探针：枚举设备 + 独占初始化 + 回调喂数据
 * 用法: node tools/test-wasapi.js [文件路径] [设备号]
 */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

const NATIVE = path.join(__dirname, '..', 'native', 'win32-x64');
const bass = koffi.load(path.join(NATIVE, 'bass.dll'));
const wasapi = koffi.load(path.join(NATIVE, 'basswasapi.dll'));

const BASS_Init = bass.func('bool __stdcall BASS_Init(int device, uint32 freq, uint32 flags, void *win, void *clsid)');
const BASS_ErrorGetCode = bass.func('int __stdcall BASS_ErrorGetCode()');
const BASS_StreamCreateFile = bass.func('uint32 __stdcall BASS_StreamCreateFile(bool mem, void *file, int64 offset, int64 length, uint32 flags)');
const BASS_ChannelGetData = bass.func('uint32 __stdcall BASS_ChannelGetData(uint32 handle, void *buffer, uint32 length)');
const BASS_ChannelGetInfo = bass.func('bool __stdcall BASS_ChannelGetInfo(uint32 handle, void *info)');
const BASS_ChannelIsActive = bass.func('uint32 __stdcall BASS_ChannelIsActive(uint32 handle)');
const BASS_StreamFree = bass.func('bool __stdcall BASS_StreamFree(uint32 handle)');
const BASS_PluginLoad = bass.func('uint32 __stdcall BASS_PluginLoad(void *file, uint32 flags)');
const BASS_SetConfig = bass.func('bool __stdcall BASS_SetConfig(uint32 opt, uint32 value)');

const GetDeviceInfo = wasapi.func('bool __stdcall BASS_WASAPI_GetDeviceInfo(uint32 device, void *info)');
const GetInfo = wasapi.func('bool __stdcall BASS_WASAPI_GetInfo(void *info)');
const Init = wasapi.func('bool __stdcall BASS_WASAPI_Init(int device, uint32 freq, uint32 chans, uint32 flags, float buffer, float period, void *proc, void *user)');
const Start = wasapi.func('bool __stdcall BASS_WASAPI_Start()');
const Stop = wasapi.func('bool __stdcall BASS_WASAPI_Stop(bool reset)');
const Free = wasapi.func('bool __stdcall BASS_WASAPI_Free()');
const GetVersion = wasapi.func('uint32 __stdcall BASS_WASAPI_GetVersion()');

const DEVINFO = koffi.struct('BASS_WASAPI_DEVICEINFO', {
  flags: 'uint32',
  minperiod: 'uint32',
  defperiod: 'uint32',
  mixfreq: 'uint32',
  mixchans: 'uint32',
  name: 'char[256]',
});

const INFO = koffi.struct('BASS_WASAPI_INFO', {
  freq: 'uint32',
  chans: 'uint32',
  format: 'uint32',
  buflen: 'uint32',
  volmax: 'uint32',
  volmin: 'uint32',
  volstep: 'uint32',
});

const CHINFO = koffi.struct('BASS_CHANNELINFO', {
  freq: 'uint32',
  chans: 'uint32',
  flags: 'uint32',
  ctype: 'uint32',
  origres: 'uint32',
  plugin: 'uint32',
  sample: 'uint32',
  filename: 'char[256]',
});

const BASS_WASAPI_EXCLUSIVE = 1;
const BASS_WASAPI_AUTOFORMAT = 2;
const BASS_SAMPLE_FLOAT = 256;
const BASS_STREAM_DECODE = 0x200000;

function vstr(v) { return `${v >>> 16}.${v & 0xffff}`; }
console.log('basswasapi:', vstr(GetVersion()));

BASS_SetConfig(42, 1); // UNICODE
if (!BASS_Init(0, 48000, 0, null, null)) {
  console.log('BASS_Init failed err=', BASS_ErrorGetCode());
}
const flac = path.join(NATIVE, 'bassflac.dll');
if (fs.existsSync(flac)) BASS_PluginLoad(Buffer.from(flac + '\0', 'utf16le'), 0x80000000);

// ── 枚举 WASAPI 设备 ──
console.log('\n=== WASAPI 设备 ===');
const devs = [];
for (let i = 0; i < 12; i++) {
  const dibp = koffi.alloc('uint8', 1024);
  if (!GetDeviceInfo(i, dibp)) break;
  const dib = Buffer.from(koffi.decode(dibp, 'uint8', 1024));
  const dflags = dib.readUInt32LE(0);
  const minperiod = dib.readUInt32LE(4);
  const defperiod = dib.readUInt32LE(8);
  const mixfreq = dib.readUInt32LE(12);
  const mixchans = dib.readUInt32LE(16);
  const nm = dib.slice(20);
  let name = nm.toString('utf16le').split('\0')[0];
  if (!name) name = nm.toString('latin1').split('\0')[0];
  const flagNames = [];
  if (dflags & 1) flagNames.push('ENABLED');
  if (dflags & 2) flagNames.push('DEFAULT');
  if (dflags & 4) flagNames.push('INIT');
  if (dflags & 8) flagNames.push('LOOPBACK');
  if (dflags & 0x10) flagNames.push('INPUT');
  devs.push({ i, name, flags: flagNames.join('|'), mixfreq, mixchans });
  console.log(`[${i}] ${JSON.stringify(name)}  (${flagNames.join('|')}) mix=${mixfreq}Hz/${mixchans}ch period=${minperiod}/${defperiod}`);
}

const target = Number(process.argv[3] || 0);
const file = process.argv[2] || path.join(__dirname, '..', '..', 'OneDrive', 'Music');
console.log(`\n=== 试设备 ${target}，独占模式 ===`);

// 找一个 FLAC 试
let track = file;
if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
  const walk = (d, depth = 0) => {
    if (depth > 3) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
      else if (/\.(flac|wav|mp3)$/i.test(e.name)) return p;
    }
    return null;
  };
  track = walk(file) || null;
}

let chan = 0;
if (track) {
  chan = BASS_StreamCreateFile(false, Buffer.from(path.resolve(track) + '\0', 'utf16le'),
    0, 0, BASS_STREAM_DECODE | BASS_SAMPLE_FLOAT | 0x80000000);
  const cib = Buffer.alloc(koffi.sizeof(CHINFO));
  const ci = BASS_ChannelGetInfo(chan, cib) ? koffi.decode(cib, CHINFO) : null;
  if (chan && ci) {
    console.log(`源: ${path.basename(track)}  ${ci.freq}Hz/${ci.chans}ch`);
  } else {
    console.log('流创建失败 err=', BASS_ErrorGetCode());
  }
}

// 回调：从解码流取数据填给 WASAPI
let pulled = 0;
const proto = koffi.proto('uint32 __stdcall WASAPIPROC(void *buffer, uint32 length, void *user)');
const proc = koffi.register((buffer, length) => {
  if (!chan) {
    koffi.decode(buffer, 'uint8', length); // 不填，静音
    return length;
  }
  const got = BASS_ChannelGetData(chan, buffer, length);
  if (got === 0xFFFFFFFF || got === 0) return length;   // 静音填充
  pulled += got;
  return got;
}, koffi.pointer(proto));

const ok = Init(target, 0, 0, BASS_WASAPI_EXCLUSIVE | BASS_WASAPI_AUTOFORMAT, 0.3, 0.02, proc, null);
console.log('Init 独占:', ok, ok ? '' : `err=${BASS_ErrorGetCode()}`);

if (ok) {
  const infp = koffi.alloc('uint8', 64);
  if (GetInfo(infp)) {
    const infb = Buffer.from(koffi.decode(infp, 'uint8', 64));
    console.log(`设备格式: ${infb.readUInt32LE(0)}Hz/${infb.readUInt32LE(4)}ch fmt=0x${infb.readUInt32LE(8).toString(16)} buf=${infb.readUInt32LE(12)}`);
  }
  const started = Start();
  console.log('Start:', started);
  setTimeout(() => {
    console.log(`\n=== 3 秒后 ===`);
    console.log('拉取字节数:', pulled, pulled ? `≈ ${(pulled / (48000 * 8)).toFixed(2)} 秒音频` : '(无数据)');
    Stop(true);
    Free();
    if (chan) BASS_StreamFree(chan);
    process.exit(0);
  }, 3000);
} else {
  if (chan) BASS_StreamFree(chan);
  process.exit(1);
}
