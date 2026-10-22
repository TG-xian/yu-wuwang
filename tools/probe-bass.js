/**
 * BASS 探针：验证 koffi 能加载 bass.dll / bassflac.dll / bassasio.dll，
 * 并读出各自版本号。不初始化音频设备，不碰声卡。
 */
const koffi = require('koffi');
const path = require('node:path');

const NATIVE = path.join(__dirname, '..', 'native', 'win32-x64');
const ver = (v) => `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;

function loadBass() {
  const bass = koffi.load(path.join(NATIVE, 'bass.dll'));
  const BASS_GetVersion = bass.func('uint32 BASS_GetVersion()');
  console.log('  bass.dll     v' + ver(BASS_GetVersion()));
  return bass;
}

function loadFlac(bass) {
  const BASS_PluginLoad = bass.func('int BASS_PluginLoad(const char *file, uint32 flags)');
  const BASS_PluginGetInfo = bass.func('void *BASS_PluginGetInfo(int handle)');
  const h = BASS_PluginLoad(path.join(NATIVE, 'bassflac.dll'), 0);
  if (!h) {
    const BASS_ErrorGetCode = bass.func('int BASS_ErrorGetCode()');
    throw new Error('bassflac 加载失败, err=' + BASS_ErrorGetCode());
  }
  console.log('  bassflac.dll 插件句柄 = ' + h);
  return h;
}

function loadAsio() {
  const asio = koffi.load(path.join(NATIVE, 'bassasio.dll'));
  const BASS_ASIO_GetVersion = asio.func('uint32 BASS_ASIO_GetVersion()');
  console.log('  bassasio.dll v' + ver(BASS_ASIO_GetVersion()));
  return asio;
}

console.log('=== BASS 探针 ===');
try {
  const bass = loadBass();
  loadFlac(bass);
  loadAsio();
  console.log('=== 三个 DLL 全部可加载 ===');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
