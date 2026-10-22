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
  BASS_SAMPLE_FLOAT: 0x100,
  BASS_UNICODE: 0x80000000,
  BASS_ASIO_THREAD: 1,
  BASS_ASIO_FORMAT_16BIT: 16,
  BASS_ASIO_FORMAT_24BIT: 17,
  BASS_ASIO_FORMAT_32BIT: 18
};

class AudioEngine {
  constructor(opts = {}) {
    this.deviceIndex = Number(opts.deviceIndex ?? 0);
    this.bufSize = Number(opts.bufSize ?? 0); // 0 = 驱动默认
    this.bassReady = false;
    this.asioReady = false;
    this.chan = 0;
    this.info = null;       // { freq, chans, bits, dur }
    this.state = 'idle';    // idle | loading | ready | playing | paused | error
    this.outputMode = 'asio';   // asio | wasapi | hog（macOS 独占）
    this.wasapiDev = null;
    this.hogDev = null;         // macOS：当前独占的设备
    this.hogRate = 0;           // macOS：当前独占的采样率
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
    if (!this.BASS_Init(0, 48000, 0, null, null)) {
      throw new Error(`BASS_Init 失败 err=${this.BASS_ErrorGetCode()}`);
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

  /** 加载并准备播放（不自动起播）。mode: 'asio'（默认，独占）| 'wasapi'（共享） */
  load(source, { deviceIndex, mode = 'asio' } = {}) {
    this.state = 'loading';
    try {
      // ── WASAPI 共享 ──
      if (mode === 'wasapi') {
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

      // ── macOS：CoreAudio hog 独占 ──
      // ASIO 是 Steinberg 为 Windows 定的，mac 上没有。BASS 在 mac 用
      // BASS_DEVICE_HOG 走 CoreAudio 的 hog mode：设备被本应用独占，
      // 系统混音器被踢出链路，样本直送 DAC。
      // 采样率匹配靠 BASS_DEVICE_FREQ —— 让「设备」切到流的速率，
      // 而不是让「流」被重采样，这两件事在 bit-perfect 上是相反的。
      if (!IS_WIN) {
        this._ensureBass();

        // 先建流，只为了读出源采样率（设备速率得跟着它走）
        let chan = this._createStream(source, false);
        if (!chan) throw new Error(`建流失败 err=${this.BASS_ErrorGetCode()}（URL 失效或无权限？）`);
        const probe = this._readInfo(chan);
        if (!probe) {
          try { this.BASS_StreamFree(chan); } catch {}
          throw new Error(`读流信息失败 err=${this.BASS_ErrorGetCode()}`);
        }

        const dev = deviceIndex ?? this.deviceIndex;
        const wantRate = probe.freq;

        // 设备/速率都没变就不重开设备（重开会有一下静默）
        const needReinit = !(
          this.outputMode === 'hog' && this.bassReady &&
          this.hogDev === dev && this.hogRate === wantRate
        );

        if (needReinit) {
          try { this.BASS_StreamFree(chan); } catch {}
          if (this.chan) { try { this.BASS_StreamFree(this.chan); } catch {} this.chan = 0; }

          this._reinitBass(dev, wantRate, F.BASS_DEVICE_HOG | F.BASS_DEVICE_FREQ);
          this.outputMode = 'hog';
          this.hogDev = dev;
          this.hogRate = wantRate;

          chan = this._createStream(source, false);
          if (!chan) throw new Error(`重建流失败 err=${this.BASS_ErrorGetCode()}`);
        } else if (this.chan) {
          try { this.BASS_StreamFree(this.chan); } catch {}
        }

        this.chan = chan;
        const info = this._readInfo(chan) || probe;
        this.info = info;

        if (!this.BASS_ChannelPlay(chan, 1)) {
          throw new Error(`播放失败 err=${this.BASS_ErrorGetCode()}`);
        }
        this.state = 'ready';
        console.log(`[audio] hog ready ${info.freq}Hz/${info.chans}ch dev=${dev}（独占，未验证）`);
        return { ok: true, info, deviceRate: wantRate, mode: 'hog' };
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
    if (this.outputMode === 'hog') {
      // macOS：hog 模式下是普通播放流，BASS 自己往设备送
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
    if (this.outputMode === 'hog' || this.outputMode === 'wasapi') {
      this.BASS_ChannelPause(this.chan);
    } else {
      // ASIO 下是解码流，不能 Pause，只能停 ASIO；恢复时再 Start
      this.BASS_ASIO_Stop();
    }
    return { ok: true };
  }

  resume() {
    if (!this.chan) return { ok: false, error: '未加载' };
    if (this.outputMode === 'hog' || this.outputMode === 'wasapi') {
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
    if ((this.outputMode === 'hog' || this.outputMode === 'wasapi') && this.chan) {
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
      out: this.outputMode === 'wasapi'
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
