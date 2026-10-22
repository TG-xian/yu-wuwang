/**
 * 音频引擎：BASS 解码 + ASIO/WASAPI 输出
 *
 * 设计要点
 *  - BASS 懒初始化：引擎进程启动时不碰声卡，第一次 load 才 Init
 *  - ASIO 每次换曲重新协商：ChannelEnableBASS → SetRate → Start
 *    （顺序照官方 contest.c；SetRate 在 Enable 之后）
 *  - 停止即释放设备：ASIO 是单客户端，长期占用会让系统其他声音全哑
 *  - 绝不偷偷重采样：SetRate 失败直接报错，交给上层提示换 WASAPI
 */
const koffi = require('koffi');
const path = require('node:path');
const fs = require('node:fs');

const IS_WIN = process.platform === 'win32';
const NATIVE = path.join(__dirname, '..', 'native', IS_WIN ? 'win32-x64' : 'darwin');
const DLL = IS_WIN ? '.dll' : '.dylib';
// macOS 的动态库统一带 lib 前缀（libbass.dylib / libbassflac.dylib）
const LIBP = IS_WIN ? '' : 'lib';

const F = {
  BASS_STREAM_DECODE: 0x200000,
  // macOS 独占：CoreAudio hog mode（bass.h 里 BASS_DEVICE_HOG 0x10000）
  BASS_DEVICE_HOG: 0x10000,
  // 让设备切到指定采样率（配合 HOG 用：设备跟随流，而不是流被重采样）
  BASS_DEVICE_FREQ: 0x8000,
  // BASS_DEVICEINFO.flags 位（仅 macOS 枚举用）
  BASS_DEVICE_ENABLED: 0x1,   // 设备可用（0 = 已禁用 / 已拔出）
  BASS_DEVICE_DEFAULT: 0x2,   // 该设备是系统默认设备
  BASS_SAMPLE_FLOAT: 0x100,
  BASS_UNICODE: 0x80000000,
  BASS_ASIO_THREAD: 1,
  BASS_ASIO_FORMAT_16BIT: 16,
  BASS_ASIO_FORMAT_24BIT: 17,
  BASS_ASIO_FORMAT_32BIT: 18
};

/**
 * BASS_DEVICEINFO（bass.h）——只用于 macOS 设备枚举。
 *
 * 64 位平台字节布局（sizeof = 24，alignof = 8，已用 koffi.sizeof 实测确认）：
 *   偏移 0  : char  *name    设备名（8 字节指针）
 *   偏移 8  : char  *driver  驱动名（8 字节指针，CoreAudio 上多为空串）
 *   偏移 16 : uint32 flags   （4 字节）
 *   偏移 20 : padding        （4 字节，结构按 8 字节对齐）
 *
 * 用 koffi.struct 让 koffi 自己按 char* 解出 JS 字符串；
 * 出参用空对象，koffi 会把 name/driver/flags 填回这个对象。
 */
const BASS_DEVICEINFO = koffi.struct('BASS_DEVICEINFO', {
  name: 'const char *',
  driver: 'const char *',
  flags: 'uint32'
});


class AudioEngine {
  constructor(opts = {}) {
    this.deviceIndex = Number(opts.deviceIndex ?? 0);
    this.bufSize = Number(opts.bufSize ?? 0); // 0 = 驱动默认
    this.bassReady = false;
    this.asioReady = false;
    this.chan = 0;
    this.info = null;       // { freq, chans, bits, dur }
    this.state = 'idle';    // idle | loading | ready | playing | paused | error
    // asio | wasapi（Windows） | exclusive | shared | hog（macOS，hog 为 exclusive 的旧名）
    this.outputMode = 'asio';
    this.wasapiDev = null;
    this.hogDev = null;         // macOS：当前独占的设备（-1 = 系统默认设备）
    this.hogRate = 0;           // macOS：当前独占的采样率
    this.hogName = '';          // macOS：独占设备名（只用于日志/诊断）
    this.sharedDev = null;      // macOS：当前共享输出的设备（-1 = 系统默认设备）
    this.sharedName = '';       // macOS：共享设备名
    this.degraded = false;      // macOS：本次输出是不是独占失败后回落来的
    this.volume = 1.0;      // 0..1，走 ASIO 通道增益，不动 BASS_ATTRIB_VOL
    this.lastError = '';
    this._loadFns();
  }

  _loadFns() {
    this.bass = koffi.load(path.join(NATIVE, `${LIBP}bass${DLL}`));
    // BASSASIO 只有 Windows 版；macOS 用 BASS 原生的 CoreAudio hog 独占
    this.asio = IS_WIN ? koffi.load(path.join(NATIVE, `bassasio${DLL}`)) : null;   // macOS 无 BASSASIO

    const b = this.bass;
    this.BASS_SetConfig = b.func('int BASS_SetConfig(uint32 option, uint32 value)');
    this.BASS_Init = b.func('int BASS_Init(int device, uint32 freq, uint32 flags, void *win, void *proc)');
    this.BASS_Free = b.func('int BASS_Free()');
    this.BASS_ErrorGetCode = b.func('int BASS_ErrorGetCode()');
    this.BASS_PluginLoad = b.func('int BASS_PluginLoad(const char *file, uint32 flags)');
    this.BASS_StreamCreateFile = b.func('uint32 BASS_StreamCreateFile(int mem, const char *file, uint64 offset, uint64 length, uint32 flags)');
    this.BASS_StreamCreateURL = b.func('uint32 BASS_StreamCreateURL(const char *url, uint32 offset, uint32 flags, void *proc, void *user)');
    this.BASS_StreamFree = b.func('int BASS_StreamFree(uint32 handle)');
    this.BASS_ChannelGetInfo = b.func('int BASS_ChannelGetInfo(uint32 handle, void *info)');
    this.BASS_ChannelGetLength = b.func('uint64 BASS_ChannelGetLength(uint32 handle, uint32 mode)');
    this.BASS_ChannelGetPosition = b.func('uint64 BASS_ChannelGetPosition(uint32 handle, uint32 mode)');
    this.BASS_ChannelBytes2Seconds = b.func('double BASS_ChannelBytes2Seconds(uint32 handle, uint64 pos)');
    this.BASS_ChannelSeconds2Bytes = b.func('uint64 BASS_ChannelSeconds2Bytes(uint32 handle, double pos)');
    this.BASS_ChannelSetPosition = b.func('int BASS_ChannelSetPosition(uint32 handle, uint64 pos, uint32 mode)');
    this.BASS_ChannelIsActive = b.func('int BASS_ChannelIsActive(uint32 handle)');
    this.BASS_ChannelPlay = b.func('int BASS_ChannelPlay(uint32 handle, int restart)');
    this.BASS_ChannelPause = b.func('int BASS_ChannelPause(uint32 handle)');
    this.BASS_ChannelSetDevice = b.func('int BASS_ChannelSetDevice(uint32 handle, uint32 device)');
    // 设备枚举（只有 macOS 的 listDevices 会调用；Windows 不枚举，保持现有设备路径不变）
    this.BASS_GetDeviceInfo = b.func('int BASS_GetDeviceInfo(uint32 device, _Out_ BASS_DEVICEINFO *info)');

    const a = this.asio;
    if (a) {
      this.BASS_ASIO_Init = a.func('int BASS_ASIO_Init(int device, uint32 flags)');
      this.BASS_ASIO_Free = a.func('int BASS_ASIO_Free()');
      this.BASS_ASIO_SetRate = a.func('int BASS_ASIO_SetRate(double rate)');
      this.BASS_ASIO_GetRate = a.func('double BASS_ASIO_GetRate()');
      this.BASS_ASIO_ChannelEnableBASS = a.func('int BASS_ASIO_ChannelEnableBASS(int input, uint32 channel, uint32 handle, int join)');
      this.BASS_ASIO_Start = a.func('int BASS_ASIO_Start(uint32 bufsize, uint32 pri)');
      this.BASS_ASIO_Stop = a.func('int BASS_ASIO_Stop()');
      this.BASS_ASIO_GetCPU = a.func('double BASS_ASIO_GetCPU()');
      this.BASS_ASIO_ChannelSetVolume = a.func('int BASS_ASIO_ChannelSetVolume(int input, uint32 channel, double volume)');
      this.BASS_ASIO_ErrorGetCode = a.func('int BASS_ASIO_ErrorGetCode()');
    }
  }

  /** 懒初始化 BASS（只做一次） */
  _ensureBass() {
    if (this.bassReady) return;
    this.BASS_SetConfig(42, 1); // BASS_CONFIG_UNICODE
    // macOS：-1 = 系统默认设备。BASS 的设备 0 是「No sound」虚拟设备，
    // 在老代码里传 0 就是 mac 装上没声音的根因（Windows 的 0 语义不同，保持不动）。
    const initDev = IS_WIN ? 0 : -1;
    if (!this.BASS_Init(initDev, 48000, 0, null, null)) {
      throw new Error(`BASS_Init(dev=${initDev}) 失败 err=${this.BASS_ErrorGetCode()}`);
    }
    const flac = path.join(NATIVE, `${LIBP}bassflac${DLL}`);
    if (fs.existsSync(flac) && !this.BASS_PluginLoad(flac, 0)) {
      throw new Error(`bassflac 加载失败 err=${this.BASS_ErrorGetCode()}`);
    }
    this.bassReady = true;
  }

  /**
   * 重新初始化 BASS 到指定设备，用于切换输出方式。
   * 切设备必须 BASS_Free 再 Init：BASS 的默认设备在 Init 时绑定，不能中途改。
   * 代价是当前流会被丢弃，所以调用方必须在建流之前做。
   */
  _reinitBass(device, freq = 48000, flags = 0) {
    if (this.asioReady) {
      try { this.BASS_ASIO_Stop(); } catch {}
      try { this.BASS_ASIO_Free(); } catch {}
      this.asioReady = false;
    }
    if (this.chan) { try { this.BASS_StreamFree(this.chan); } catch {} this.chan = 0; }
    if (this.bassReady) { try { this.BASS_Free(); } catch {} this.bassReady = false; }
    this.info = null;

    this.BASS_SetConfig(42, 1); // UNICODE
    if (!this.BASS_Init(device, freq, flags, null, null)) {
      throw new Error(`BASS_Init(dev=${device}, ${freq}Hz, flags=0x${flags.toString(16)}) 失败 err=${this.BASS_ErrorGetCode()}`);
    }
    const flac = path.join(NATIVE, `${LIBP}bassflac${DLL}`);
    if (fs.existsSync(flac)) this.BASS_PluginLoad(flac, 0);
    this.bassReady = true;
  }

  /** 建流：URL 走 StreamCreateURL（ASCII，不加 UNICODE）；本地文件走 UTF-16 + UNICODE */
  _createStream(source, decode = true) {
    // decode=true ：给 ASIO 拉流用（解码流，由外部喂数据）
    // decode=false：给 WASAPI 共享用（普通播放流，BASS 自己输出；解码流不能 ChannelPlay）
    const flags = F.BASS_SAMPLE_FLOAT | (decode ? F.BASS_STREAM_DECODE : 0);
    const isUrl = /^https?:\/\//i.test(source);
    if (isUrl) {
      return this.BASS_StreamCreateURL(source, 0, flags, null, null);
    }
    const buf = Buffer.from(source + '\u0000', 'utf16le');
    return this.BASS_StreamCreateFile(0, buf, 0n, 0n, flags | F.BASS_UNICODE);
  }

  _readInfo(chan) {
    const b = Buffer.alloc(64, 0);
    if (!this.BASS_ChannelGetInfo(chan, b)) return null;
    const origres = b.readUInt32LE(16);
    const len = this.BASS_ChannelGetLength(chan, 0);
    return {
      freq: b.readUInt32LE(0),
      chans: b.readUInt32LE(4),
      bits: origres & 0xffff,
      dur: this.BASS_ChannelBytes2Seconds(chan, len)
    };
  }

  /* ────────────────────────────────────────────────────────────────
     macOS 专有：设备枚举 + 共享/独占两种输出。
     Windows 不进入这些函数（调用点全部在 !IS_WIN 分支里）。
     ──────────────────────────────────────────────────────────────── */

  /**
   * 枚举输出设备（仅 macOS）。
   * BASS 的 device 0 是「No sound」，所以从 1 开始问，一直问到 GetDeviceInfo 返回 0。
   * 过滤 flags 不含 0x1（disabled）的设备。
   * Windows 返回 []（渲染层按平台判断；不实现 Windows 枚举，避免碰已实测的设备路径）。
   */
  listDevices() {
    if (IS_WIN) return [];
    const out = [];
    // 枚举期间关掉 BASS_UNICODE，让 BASS 返回 UTF-8 设备名，
    // 正好对上 koffi 的 char* → JS 字符串（UTF-8）解码。
    // BASS_SetConfig 返回的是「旧值」，枚举完原样恢复。
    let prev = 0;
    try { prev = this.BASS_SetConfig(42, 0); } catch { prev = 0; }
    try {
      for (let i = 1; i <= 64; i++) {
        const o = {};
        let ok = 0;
        try { ok = this.BASS_GetDeviceInfo(i, o); } catch { break; }
        if (!ok) break;                                   // 没有更多设备了
        const flags = (o.flags || 0) >>> 0;
        if (!(flags & F.BASS_DEVICE_ENABLED)) {           // 0x1 = enabled
          console.log(`[audio] [mac] 跳过未启用设备 dev=${i} name="${o.name || ''}" flags=0x${flags.toString(16)}`);
          continue;
        }
        out.push({
          index: i,
          name: o.name || `设备 ${i}`,
          driver: o.driver || '',
          isDefault: !!(flags & F.BASS_DEVICE_DEFAULT)    // 0x2 = default
        });
      }
    } finally {
      try { this.BASS_SetConfig(42, prev); } catch {}
    }
    // 个别 CoreAudio 驱动不置 BASS_DEVICE_DEFAULT：退一步把第一台可用设备当默认，
    // 否则 UI 上没有任何设备带「· 默认」标记。只影响显示，不改变实际输出设备选择。
    if (out.length && !out.some((d) => d.isDefault)) out[0].isDefault = true;
    // 实测（CI macos-14 arm64）：CoreAudio 上有两台设备同时带 default 位，
    // 只保留第一台的标记，否则菜单里会出现两个「· 默认」。
    const firstDef = out.findIndex((d) => d.isDefault);
    out.forEach((d, i) => { if (i !== firstDef) d.isDefault = false; });
    console.log(`[audio] [mac] listDevices ${out.length} 台:` +
      (out.length ? ' ' + out.map((d) => `${d.index}:"${d.name}"${d.isDefault ? '(默认)' : ''}`).join(' | ') : ' （无）'));
    return out;
  }

  /**
   * 渲染层传来的 outDevice → BASS 设备号。
   * 'default' / undefined / 非法值 / 0 一律变成 -1（BASS 惯用法 = 系统默认设备）。
   * 0 必须拦下：BASS 里 0 是「No sound」虚拟设备，mac 上传 0 = 静音。
   */
  _resolveMacDevice(deviceIndex) {
    if (deviceIndex === undefined || deviceIndex === null) return -1;
    if (typeof deviceIndex === 'string' && deviceIndex.trim().toLowerCase() === 'default') return -1;
    const n = Number(deviceIndex);
    if (!Number.isFinite(n) || n < 1) return -1;   // 含 0、负数、NaN
    return Math.trunc(n);
  }

  /** 设备名（仅日志/诊断用；-1 时取默认设备的名字） */
  _devName(dev) {
    if (IS_WIN) return '';
    try {
      const n = Number(dev);
      if (Number.isFinite(n) && n >= 1) {
        const o = {};
        if (this.BASS_GetDeviceInfo(n, o)) return o.name || '';
      }
      const list = this.listDevices();
      const d = list.find((x) => x.isDefault) || list[0];
      return d ? d.name : '(系统默认设备)';
    } catch { return ''; }
  }

  /**
   * macOS 共享输出：BASS_Init 不带 BASS_DEVICE_HOG，走 CoreAudio 系统混音器。
   * 设备被系统共享，任何设备都能出声（代价：非 bit-perfect，采样率由系统定）。
   * dev 必须是已解析好的设备索引（-1 = 系统默认设备），调用前不要传 0。
   */
  _macSharedLoad(source, dev, extra = {}) {
    const label = extra.degraded ? 'shared(降级回落)' : 'shared';
    // 设备/模式没变就不重开设备（重开会有一下静默）
    const needReinit = !(
      this.outputMode === 'shared' && this.bassReady && this.sharedDev === dev
    );

    if (needReinit) {
      if (this.chan) { try { this.BASS_StreamFree(this.chan); } catch {} this.chan = 0; }
      this._reinitBass(dev, 48000, 0);          // 无 HOG、无 FREQ：交给系统混音
      this.outputMode = 'shared';
      this.sharedDev = dev;
      this.sharedName = this._devName(dev);
      this.hogDev = null;
      this.hogRate = 0;
      this.hogName = '';
      this.degraded = !!extra.degraded;
      console.log(`[audio] [mac] ${label} 设备已打开 dev=${dev} name="${this.sharedName}" (48000Hz, 无 HOG)`);
    } else if (this.chan) {
      try { this.BASS_StreamFree(this.chan); } catch {}
      this.chan = 0;
    }

    const chan = this._createStream(source, false);   // 普通播放流，BASS 自己送设备
    if (!chan) throw new Error(`建流失败 err=${this.BASS_ErrorGetCode()}（URL 失效或无权限？）`);
    this.chan = chan;

    const info = this._readInfo(chan);
    if (!info) throw new Error(`读流信息失败 err=${this.BASS_ErrorGetCode()}`);
    this.info = info;

    if (!this.BASS_ChannelPlay(chan, 1)) {
      throw new Error(`共享播放失败 dev=${dev} err=${this.BASS_ErrorGetCode()}`);
    }
    this.state = 'ready';
    console.log(`[audio] [mac] ${label} ready ${info.freq}Hz/${info.chans}ch dev=${dev} ` +
      `name="${this.sharedName}" degraded=${this.degraded}${extra.reason ? ` reason=${extra.reason}` : ''}`);
    return {
      ok: true, info, mode: 'shared', device: dev, deviceName: this.sharedName,
      degraded: this.degraded, reason: extra.reason || null,
      note: 'CoreAudio 共享：经系统混音，非 bit-perfect'
    };
  }

  /**
   * macOS 独占输出：BASS_DEVICE_HOG（设备从系统混音器里摘出来）+ BASS_DEVICE_FREQ
   * （让设备切到流采样率，而不是让流被重采样）。失败由 load() 捕获后回落共享。
   */
  _macExclusiveLoad(source, deviceIndex) {
    const dev = this._resolveMacDevice(deviceIndex);
    this._ensureBass();

    // 先建流，只为了读出源采样率（设备速率得跟着它走）
    let chan = this._createStream(source, false);
    if (!chan) throw new Error(`建流失败 err=${this.BASS_ErrorGetCode()}（URL 失效或无权限？）`);
    const probe = this._readInfo(chan);
    if (!probe) {
      try { this.BASS_StreamFree(chan); } catch {}
      throw new Error(`读流信息失败 err=${this.BASS_ErrorGetCode()}`);
    }

    const wantRate = probe.freq;
    const needReinit = !(
      (this.outputMode === 'exclusive' || this.outputMode === 'hog') && this.bassReady &&
      this.hogDev === dev && this.hogRate === wantRate
    );

    if (needReinit) {
      try { this.BASS_StreamFree(chan); } catch {}
      if (this.chan) { try { this.BASS_StreamFree(this.chan); } catch {} this.chan = 0; }
      // 这一步是独占成败的关键：HOG 被别的进程占用、设备不支持该速率都会抛
      this._reinitBass(dev, wantRate, F.BASS_DEVICE_HOG | F.BASS_DEVICE_FREQ);
      this.outputMode = 'exclusive';
      this.hogDev = dev;
      this.hogRate = wantRate;
      this.hogName = this._devName(dev);
      this.sharedDev = null;
      this.sharedName = '';
      this.degraded = false;
      console.log(`[audio] [mac] exclusive 设备已独占 dev=${dev} name="${this.hogName}" hogRate=${wantRate}Hz`);
      chan = this._createStream(source, false);
      if (!chan) throw new Error(`重建流失败 err=${this.BASS_ErrorGetCode()}`);
    } else if (this.chan) {
      try { this.BASS_StreamFree(this.chan); } catch {}
    }

    this.chan = chan;
    const info = this._readInfo(chan) || probe;
    this.info = info;

    if (!this.BASS_ChannelPlay(chan, 1)) {
      throw new Error(`独占播放失败 dev=${dev} err=${this.BASS_ErrorGetCode()}`);
    }
    this.state = 'ready';
    const bp = Math.abs(wantRate - info.freq) < 1;
    console.log(`[audio] [mac] exclusive ready ${info.freq}Hz/${info.chans}ch dev=${dev} ` +
      `name="${this.hogName}" hogRate=${wantRate}Hz bitperfect=${bp}`);
    return {
      ok: true, info, deviceRate: wantRate, mode: 'exclusive', device: dev,
      deviceName: this.hogName, bitperfect: bp, degraded: false
    };
  }

  /** 加载并准备播放（不自动起播）。
   *  mode: 'exclusive' 独占（默认；老名字 'asio'/'hog' 等价）
   *        'shared'    共享（老名字 'wasapi' 等价）
   */
  load(source, { deviceIndex, mode = 'asio' } = {}) {
    this.state = 'loading';
    try {
      // 模式别名（新旧名字都要能用）：
      //   shared    = 'wasapi'  → Windows: WASAPI 共享   / macOS: CoreAudio 共享（系统混音）
      //   exclusive = 'asio' | 'hog' → Windows: ASIO 独占 / macOS: CoreAudio HOG 独占
      // 注意：未知 mode 仍按独占走（与改动前一致）。
      const wantShared = mode === 'wasapi' || mode === 'shared';

      // ── WASAPI 共享 ──
      if (wantShared && IS_WIN) {
        const dev = deviceIndex ?? 1;
        if (!(this.outputMode === 'wasapi' && this.wasapiDev === dev && this.bassReady)) {
          this._reinitBass(dev, 48000);
          this.outputMode = 'wasapi';
          this.wasapiDev = dev;
        } else if (this.chan) {
          try { this.BASS_StreamFree(this.chan); } catch {}
          this.chan = 0;
        }

        const chan = this._createStream(source, false);   // 普通播放流
        if (!chan) throw new Error(`建流失败 err=${this.BASS_ErrorGetCode()}（URL 失效或无权限？）`);
        this.chan = chan;

        const info = this._readInfo(chan);
        if (!info) throw new Error(`读流信息失败 err=${this.BASS_ErrorGetCode()}`);
        this.info = info;

        this.BASS_ChannelSetDevice(chan, dev);
        if (!this.BASS_ChannelPlay(chan, 1)) {
          throw new Error(`WASAPI 播放失败 err=${this.BASS_ErrorGetCode()}`);
        }
        this._applyVolume();
        this.state = 'ready';
        console.log(`[audio] wasapi ready id=${this.info.freq}Hz/${this.info.chans}ch dev=${dev}`);
        return { ok: true, info, mode: 'wasapi',
                 note: 'WASAPI 共享：经系统混音，非 bit-perfect' };
      }

      // ── macOS：CoreAudio 共享 / 独占 ──
      // ASIO 是 Steinberg 为 Windows 定的，mac 上没有输出插件。BASS 在 mac 走 CoreAudio：
      //   shared    = 不带宽 BASS_DEVICE_HOG，经系统混音器 → 任何设备都能出声（默认档）
      //   exclusive = HOG 独占 + BASS_DEVICE_FREQ 跟随源采样率 → 不被系统混音，逼近 bit-perfect
      // 设备号：0 在 BASS 里是「No sound」虚拟设备，mac 上绝不能传（会静音）；
      // 「系统默认设备」用 -1 传 BASS_Init。
      if (!IS_WIN) {
        if (wantShared) {
          return this._macSharedLoad(source, this._resolveMacDevice(deviceIndex));
        }

        // 独占：被拒（HOG 抢不到 / 速率不支持 / 设备已拔）时立刻用「同一设备」改共享重试
        try {
          return this._macExclusiveLoad(source, deviceIndex);
        } catch (e) {
          const reason = e.message;
          const dev = this._resolveMacDevice(deviceIndex);
          const name = this._devName(dev);
          console.warn(`[audio] [mac] 独占失败，回落共享：dev=${dev} name="${name}" reason=${reason}`);
          try {
            const r = this._macSharedLoad(source, dev, { degraded: true, reason });
            console.log(`[audio] [mac] DEGRADED exclusive→shared ok mode=${r.mode} dev=${r.device} name="${r.deviceName}" reason=${reason}`);
            return r;
          } catch (e2) {
            throw new Error(`独占失败(${reason})；共享回落也失败(${e2.message})`);
          }
        }
      }

      // ── ASIO 独占（Windows）──
      if (this.outputMode !== 'asio') {
        this._reinitBass(0, 48000);
        this.outputMode = 'asio';
        this.wasapiDev = null;
      }
      this._ensureBass();
      // 切歌必须先释放旧流：只 Stop ASIO 不 Free 流，旧流会残留在通道上，
      // 与新流叠加 → 音量翻倍/削波（就是"特别大特别破"的成因）
      if (this.chan) {
        this._teardownOutput();
        try { this.BASS_StreamFree(this.chan); } catch {}
        this.chan = 0;
      }

      const chan = this._createStream(source);
      if (!chan) throw new Error(`建流失败 err=${this.BASS_ErrorGetCode()}（URL 失效或无权限？）`);
      this.chan = chan;

      const info = this._readInfo(chan);
      if (!info) throw new Error(`读流信息失败 err=${this.BASS_ErrorGetCode()}`);
      this.info = info;

      const dev = deviceIndex ?? this.deviceIndex;
      if (!this.asioReady) {
        if (!this.BASS_ASIO_Init(dev, F.BASS_ASIO_THREAD)) {
          throw new Error(`ASIO 初始化失败 device=${dev} err=${this.BASS_ASIO_ErrorGetCode()}`);
        }
        this.asioReady = true;
      }
      // 官方顺序：Init → ChannelEnableBASS → SetRate → Start
      if (!this.BASS_ASIO_ChannelEnableBASS(0, 0, chan, 1)) {
        throw new Error(`ASIO 通道绑定失败 err=${this.BASS_ASIO_ErrorGetCode()}`);
      }
      const before = this.BASS_ASIO_GetRate();
      if (!this.BASS_ASIO_SetRate(info.freq)) {
        throw new Error(`驱动不支持 ${info.freq} Hz（当前 ${before} Hz）—— 不重采样，请改用 WASAPI`);
      }
      if (!this.BASS_ASIO_Start(this.bufSize, 0)) {
        throw new Error(`ASIO 启动失败 err=${this.BASS_ASIO_ErrorGetCode()}`);
      }
      this.state = 'ready';
      console.log(`[audio] asio ready ${info.freq}Hz/${info.chans}ch dev=${dev} ch=${chan}`);
      return { ok: true, info, deviceRate: this.BASS_ASIO_GetRate(), mode: 'asio' };
    } catch (e) {
      console.error(`[audio] load 失败: ${e.message}`);
      this.lastError = e.message;
      this.state = 'error';
      this._teardownOutput();
      return { ok: false, error: e.message };
    }
  }

  /** 音量：优先设备通道增益（bit-perfect 不受影响）；ASIO 未就绪时记下来，下次 load 应用 */
  setVolume(v) {
    const vol = Math.max(0, Math.min(1, Number(v)));
    this.volume = vol;
    // 第一版：ASIO 独占下不做软件音量（会破坏 bit-perfect 或触发驱动削波）。
    // 音量由声卡旋钮控制；这里只记录值，供后续 WASAPI 分支或硬件混音器使用。
    return { ok: true, applied: false, volume: vol,
             note: 'ASIO 独占下音量由硬件控制，软件不调' };
  }

  _applyVolume() {
    if (!this.asioReady) return false;
    let ok = true;
    for (const ch of [0, 1]) {
      if (!this.BASS_ASIO_ChannelSetVolume(0, ch, this.volume)) ok = false;
    }
    return ok;
  }

  play() {
    if (!this.chan) return { ok: false, error: '未加载' };
    if (this.outputMode === 'hog' || this.outputMode === 'exclusive' || this.outputMode === 'shared') {
      // macOS：普通播放流，BASS 自己往设备送（共享/独占都是）
      if (!this.BASS_ChannelPlay(this.chan, 0)) {
        return { ok: false, error: `播放失败 err=${this.BASS_ErrorGetCode()}` };
      }
    } else if (this.outputMode === 'wasapi') {
      this.BASS_ChannelPlay(this.chan, 0);
    } else if (this.asioReady === false) {
      return { ok: false, error: '未加载' };
    }
    // ASIO 已在 load 时 Start，这里只需标记
    this.state = 'playing';
    return { ok: true };
  }

  pause() {
    if (!this.chan) return { ok: false, error: '未加载' };
    this.state = 'paused';
    if (this.outputMode === 'hog' || this.outputMode === 'wasapi' ||
        this.outputMode === 'exclusive' || this.outputMode === 'shared') {
      this.BASS_ChannelPause(this.chan);
    } else {
      // ASIO 下是解码流，不能 Pause，只能停 ASIO；恢复时再 Start
      this.BASS_ASIO_Stop();
    }
    return { ok: true };
  }

  resume() {
    if (!this.chan) return { ok: false, error: '未加载' };
    if (this.outputMode === 'hog' || this.outputMode === 'wasapi' ||
        this.outputMode === 'exclusive' || this.outputMode === 'shared') {
      if (!this.BASS_ChannelPlay(this.chan, 0)) {
        return { ok: false, error: `恢复失败 err=${this.BASS_ErrorGetCode()}` };
      }
    } else if (!this.BASS_ASIO_Start(this.bufSize, 0)) {
      return { ok: false, error: `ASIO 恢复失败 err=${this.BASS_ASIO_ErrorGetCode()}` };
    }
    this.state = 'playing';
    return { ok: true };
  }

  seek(seconds) {
    if (!this.chan || !this.info) return { ok: false, error: '未加载' };
    const pos = this.BASS_ChannelSeconds2Bytes(this.chan, Math.max(0, seconds));
    return { ok: !!this.BASS_ChannelSetPosition(this.chan, pos, 0) };
  }

  stop() {
    if (this.chan) {
      this.BASS_StreamFree(this.chan);
      this.chan = 0;
    }
    this._teardownOutput();
    this.info = null;
    this.state = 'idle';
    return { ok: true };
  }

  /** 释放输出设备（保留 BASS 解码器初始化） */
  _teardownOutput() {
    if ((this.outputMode === 'hog' || this.outputMode === 'wasapi' ||
         this.outputMode === 'exclusive' || this.outputMode === 'shared') && this.chan) {
      try { this.BASS_ChannelPause(this.chan); } catch {}
    }
    if (this.asioReady) {
      try { this.BASS_ASIO_Stop(); } catch {}
      try { this.BASS_ASIO_Free(); } catch {}
      this.asioReady = false;
    }
  }

  snapshot() {
    if (!this.chan || !this.info) {
      return { state: this.state, trackId: null, pos: 0, dur: 0 };
    }
    const pos = this.BASS_ChannelBytes2Seconds(this.chan, this.BASS_ChannelGetPosition(this.chan, 0));
    const active = this.BASS_ChannelIsActive(this.chan);
    return {
      state: this.state,
      pos,
      dur: this.info.dur,
      fmt: { rate: this.info.freq, bits: this.info.bits, ch: this.info.chans },
      // macOS：不能在 asioReady 上挂 rate/bitperfect —— mac 上 this.asio 恒为 null，
      // asioReady 永远 false，那就是「rate 恒 0 / bitperfect 恒 false」的 bug 根因。
      out: !IS_WIN
        ? (this.outputMode === 'exclusive' || this.outputMode === 'hog'
            ? {
                mode: 'exclusive',
                device: this.hogDev,          // -1 = 系统默认设备
                deviceName: this.hogName,
                rate: this.hogRate,           // 独占：设备已被 HOG+FREQ 切到源采样率
                cpu: 0,
                // 设备速率与流速率一致 = 链路没重采样（mac 独占才可能是 true）
                bitperfect: !!this.hogRate && Math.abs((this.hogRate || 0) - this.info.freq) < 1,
                degraded: this.degraded
              }
            : {
                mode: 'shared',
                device: this.sharedDev,       // -1 = 系统默认设备
                deviceName: this.sharedName,
                // 共享：由 CoreAudio 混音器定实际速率，这里报流的速率（诊断用）
                rate: this.info.freq,
                cpu: 0,
                bitperfect: false,            // 经系统混音，必然不是 bit-perfect
                degraded: this.degraded
              })
        : this.outputMode === 'wasapi'
        ? {
            mode: 'wasapi',
            device: this.wasapiDev,
            rate: 0,          // 共享模式由系统混音器定采样率
            cpu: 0,
            bitperfect: false // 经系统混音，必然不是 bit-perfect
          }
        : this.outputMode === 'hog'
          ? {
              mode: 'hog',
              device: this.hogDev,
              rate: this.hogRate,
              cpu: 0,
              // hog + BASS_DEVICE_FREQ 已把设备切到源采样率，速率相符即未重采样
              bitperfect: Math.abs((this.hogRate || 0) - this.info.freq) < 1
            }
          : {
              mode: 'asio',
              device: this.deviceIndex,
              rate: this.asioReady ? this.BASS_ASIO_GetRate() : 0,
              cpu: this.asioReady ? this.BASS_ASIO_GetCPU() : 0,
              bitperfect: this.asioReady && Math.abs((this.BASS_ASIO_GetRate() || 0) - this.info.freq) < 1
            },
      active
    };
  }

  shutdown() {
    this.stop();
    if (this.bassReady) { try { this.BASS_Free(); } catch {} this.bassReady = false; }
  }
}

module.exports = { AudioEngine };
