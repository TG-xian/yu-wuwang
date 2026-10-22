/**
 * ASIO 设备枚举：列出系统里注册的所有 ASIO 驱动（含 Donner Livejack）
 * 只调 BASS_ASIO_GetDeviceInfo，不初始化设备、不占用声卡。
 */
const koffi = require('koffi');
const path = require('node:path');

const NATIVE = path.join(__dirname, '..', 'native', 'win32-x64');
const asio = koffi.load(path.join(NATIVE, 'bassasio.dll'));

const GetDeviceInfo = asio.func('int BASS_ASIO_GetDeviceInfo(int device, void *info)');

console.log('=== 系统 ASIO 驱动 ===');
const found = [];
for (let i = 0; i < 16; i++) {
  const buf = Buffer.alloc(64, 0);
  const ok = GetDeviceInfo(i, buf);
  if (!ok) break;
  const raw = buf.subarray(0, 32);
  const end = raw.indexOf(0);
  const name = raw.subarray(0, end < 0 ? 32 : end).toString('latin1');
  const driver = buf.readUInt32LE(32);
  found.push({ index: i, name, driver });
  console.log(`  [${i}] "${name}"  driver=${driver}`);
}

if (!found.length) {
  console.log('  没有找到任何 ASIO 驱动');
  process.exit(2);
}

const donner = found.find((d) => /donner/i.test(d.name));
console.log('');
if (donner) {
  console.log(`=> Donner 设备索引: ${donner.index}  "${donner.name}"`);
} else {
  console.log('=> 未找到名称含 Donner 的 ASIO 驱动，先跑 list 看看');
}
