/**
 * M2 播放测试：BASS 解码 FLAC → ASIO 独占输出
 *
 * 流程照官方 contest.c：
 *   BASS_Init(no sound) → StreamCreateFile(DECODE|FLOAT)
 *   → BASS_ASIO_Init → SetRate(源采样率) → ChannelEnableBASS → Start
 *
 * 用法: node tools/play-test.js "<flac 路径>" [秒数]
 */
const koffi = require('koffi');
const path = require('node:path');
const fs = require('node:fs');

const NATIVE = 'C:/Users/tianz/Program/yu-wuwang/native/win32-x64';
const BASS_STREAM_DECODE = 0x200000;
const BASS_SAMPLE_FLOAT = 0x100;
const ASIO_THREAD = 1;

const file = process.argv[2];
const seconds = Number(process.argv[3] || 10);
const isUrl = /^https?:\/\//i.test(file || '');
if (!file || (!isUrl && !fs.existsSync(file))) {
  console.error('用法: node tools/play-test.js "<flac 路径|http 直链>" [秒数]');
  process.exit(1);
}

// ---------- BASS 核心 ----------
const bass = koffi.load(path.join(NATIVE, 'bass.dll'));
const BASS_Init = bass.func('int BASS_Init(int device, uint32 freq, uint32 flags, void *win, void *proc)');
const BASS_Free = bass.func('int BASS_Free()');
const BASS_ErrorGetCode = bass.func('int BASS_ErrorGetCode()');
const BASS_PluginLoad = bass.func('int BASS_PluginLoad(const char *file, uint32 flags)');
const BASS_StreamCreateFile = bass.func('uint32 BASS_StreamCreateFile(int mem, const char *file, uint64 offset, uint64 length, uint32 flags)');
const BASS_StreamCreateURL = bass.func('uint32 BASS_StreamCreateURL(const char *url, uint32 offset, uint32 flags, void *proc, void *user)');
const BASS_ChannelGetInfo = bass.func('int BASS_ChannelGetInfo(uint32 handle, void *info)');
const BASS_ChannelGetLength = bass.func('uint64 BASS_ChannelGetLength(uint32 handle, uint32 mode)');
const BASS_ChannelBytes2Seconds = bass.func('double BASS_ChannelBytes2Seconds(uint32 handle, uint64 pos)');
const BASS_ChannelIsActive = bass.func('int BASS_ChannelIsActive(uint32 handle)');
const BASS_ChannelGetPosition = bass.func('uint64 BASS_ChannelGetPosition(uint32 handle, uint32 mode)');

// ---------- BASSASIO ----------
const asio = koffi.load(path.join(NATIVE, 'bassasio.dll'));
const BASS_ASIO_Init = asio.func('int BASS_ASIO_Init(int device, uint32 flags)');
const BASS_ASIO_Free = asio.func('int BASS_ASIO_Free()');
const BASS_ASIO_SetRate = asio.func('int BASS_ASIO_SetRate(double rate)');
const BASS_ASIO_GetRate = asio.func('double BASS_ASIO_GetRate()');
const BASS_ASIO_ChannelEnableBASS = asio.func('int BASS_ASIO_ChannelEnableBASS(int input, uint32 channel, uint32 handle, int join)');
const BASS_ASIO_ChannelSetFormat = asio.func('int BASS_ASIO_ChannelSetFormat(int input, uint32 channel, uint32 format)');
const BASS_ASIO_Start = asio.func('int BASS_ASIO_Start(uint32 bufsize, uint32 pri)');
const BASS_ASIO_Stop = asio.func('int BASS_ASIO_Stop()');
const BASS_ASIO_GetCPU = asio.func('double BASS_ASIO_GetCPU()');
const BASS_ASIO_ErrorGetCode = asio.func('int BASS_ASIO_ErrorGetCode()');

function die(where) {
  console.error(`FAIL @ ${where}  bass_err=${BASS_ErrorGetCode()}  asio_err=${BASS_ASIO_ErrorGetCode()}`);
  cleanup();
  process.exit(2);
}

let initedBass = false, initedAsio = false;
function cleanup() {
  try { if (initedAsio) { BASS_ASIO_Stop(); BASS_ASIO_Free(); } } catch {}
  try { if (initedBass) BASS_Free(); } catch {}
}

// 0) 中文/日文路径：BASS 默认按 ANSI 打开文件 → 必须把路径转 UTF-16LE
//    并在 BASS_StreamCreateFile 的 flags 里带 BASS_UNICODE(0x80000000)
const BASS_UNICODE = 0x80000000;
const BASS_SetConfig = bass.func('int BASS_SetConfig(uint32 option, uint32 value)');
BASS_SetConfig(42, 1); // BASS_CONFIG_UNICODE：让 BASS 内部其他路径处理也用 UTF-8

// 1) BASS 用 no-sound 设备（只为解码）
if (!BASS_Init(0, 48000, 0, null, null)) die('BASS_Init');
initedBass = true;

// 2) FLAC 插件
const plug = BASS_PluginLoad(path.join(NATIVE, 'bassflac.dll'), 0);
if (!plug) die('BASS_PluginLoad');

// 3) 建解码流
//    本地文件：路径 UTF-16LE + BASS_UNICODE（中文名必需）
//    网络直链：走 StreamCreateURL，URL 是 ASCII，**不能**加 BASS_UNICODE
let chan;
if (isUrl) {
  chan = BASS_StreamCreateURL(file, 0, BASS_STREAM_DECODE | BASS_SAMPLE_FLOAT, null, null);
} else {
  const filePathBuf = Buffer.from(file + '\u0000', 'utf16le');
  chan = BASS_StreamCreateFile(0, filePathBuf, 0n, 0n,
    BASS_STREAM_DECODE | BASS_SAMPLE_FLOAT | BASS_UNICODE);
}
if (!chan) die('BASS_StreamCreateFile');

// 4) 取源格式（BASS_CHANNELINFO: 7×u32 + char*）
const infoBuf = Buffer.alloc(64, 0);
if (!BASS_ChannelGetInfo(chan, infoBuf)) die('BASS_ChannelGetInfo');
const freq = infoBuf.readUInt32LE(0);
const chans = infoBuf.readUInt32LE(4);
const ctype = infoBuf.readUInt32LE(12);
const origres = infoBuf.readUInt32LE(16);
const bits = origres & 0xffff;
const len = BASS_ChannelGetLength(chan, 0);
const dur = BASS_ChannelBytes2Seconds(chan, len);

console.log('=== 源文件 ===');
console.log('  ' + path.basename(file));
console.log(`  采样率 ${freq} Hz / ${chans} ch / ${bits} bit   时长 ${dur.toFixed(1)}s   ctype=0x${ctype.toString(16)}`);

// 5) ASIO 初始化（索引 0 = Donner，环境变量可覆盖）
const DEV = Number(process.env.YW_ASIO_DEV || 0);
if (!BASS_ASIO_Init(DEV, ASIO_THREAD)) die(`BASS_ASIO_Init(${DEV})`);
initedAsio = true;
console.log(`=== ASIO 已初始化 (device ${DEV}) ===`);

// 6) 先把解码流接到 ASIO 输出通道 0（join=1 → 立体声）
//    官方 contest.c 的顺序：Init → ChannelEnableBASS → SetRate → Start
if (!BASS_ASIO_ChannelEnableBASS(0, 0, chan, 1)) die('BASS_ASIO_ChannelEnableBASS');

// 7) 采样率对齐源（失败=驱动不支持该率，绝不偷偷重采样）
const rateBefore = BASS_ASIO_GetRate();
if (!BASS_ASIO_SetRate(freq)) {
  console.error(`  SetRate(${freq}) 失败，当前设备率 ${rateBefore} Hz —— 驱动不支持该采样率`);
  die('BASS_ASIO_SetRate');
}
const rateAfter = BASS_ASIO_GetRate();
console.log(`  采样率 ${rateBefore} → ${rateAfter} Hz  ${Math.abs(rateAfter - freq) < 1 ? '(匹配源, 无重采样)' : '(!! 未匹配)'}`);

// 8) 启动
const bufSize = Number(process.env.YW_ASIO_BUF || 0); // 0 = 驱动默认
if (!BASS_ASIO_Start(bufSize, 0)) die('BASS_ASIO_Start');
console.log(`=== ASIO 已启动 (buf=${bufSize || '默认'}) === 开始播放 ${seconds}s`);

// 9) 跑一段时间，打印进度
const t0 = Date.now();
const timer = setInterval(() => {
  const pos = BASS_ChannelBytes2Seconds(chan, BASS_ChannelGetPosition(chan, 0));
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`  ${elapsed.toFixed(1)}s  播放位置 ${pos.toFixed(1)}s  设备率 ${BASS_ASIO_GetRate()}  CPU ${BASS_ASIO_GetCPU().toFixed(2)}%`);
  if (elapsed >= seconds) {
    clearInterval(timer);
    console.log('=== 停止，释放设备 ===');
    cleanup();
    console.log('  已释放');
    process.exit(0);
  }
}, 2000);

process.on('SIGINT', () => { cleanup(); process.exit(0); });
