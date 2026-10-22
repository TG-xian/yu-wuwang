/**
 * ASIO 设备探查 v3
 * - 名字：从注册表 HKLM\SOFTWARE\ASIO 取（BASS 的 name 字段在 x64 DLL 里读出异常）
 * - 可用性：逐个 BASS_ASIO_Init + GetInfo，校验 inputs/outputs
 */
const koffi = require('koffi');
const { execFileSync } = require('node:child_process');

const NATIVE = 'C:/Users/tianz/Program/yu-wuwang/native/win32-x64/bassasio.dll';
const asio = koffi.load(NATIVE);

const DI = koffi.struct('DI', { name: 'char[32]', driver: 'uint32' });
const INFO = koffi.struct('INFO', {
  name: 'char[32]', version: 'uint32', inputs: 'uint32', outputs: 'uint32',
  bufmin: 'uint32', bufmax: 'uint32', bufpref: 'uint32', bufgran: 'uint32'
});

const getDI = asio.func('BASS_ASIO_GetDeviceInfo', 'int', ['uint32', koffi.out(koffi.pointer(DI))]);
const init = asio.func('BASS_ASIO_Init', 'int', ['int', 'uint32']);
const free = asio.func('BASS_ASIO_Free', 'int', []);
const getInfo = asio.func('BASS_ASIO_GetInfo', 'int', [koffi.out(koffi.pointer(INFO))]);

// 注册表：拿驱动名（顺序 = 安装顺序）
const ps = `
$k = Get-ChildItem 'HKLM:\\SOFTWARE\\ASIO' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }
ConvertTo-Json @($k) -Compress
`;
let regNames = [];
try {
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  regNames = JSON.parse(raw.trim() || '[]');
  if (typeof regNames === 'string') regNames = [regNames];
} catch (e) {
  console.log('注册表读取失败:', e.message);
}
console.log('=== 注册表 ASIO 驱动 ===');
regNames.forEach((n, i) => console.log(`  reg[${i}] ${n}`));

// BASS 枚举
let count = 0;
for (let i = 0; i < 16; i++) {
  const d = { name: Array(32).fill(0), driver: 0 };
  if (!getDI(i, d)) break;
  count++;
}
console.log(`\n=== BASS 可用索引数 = ${count} ===`);

for (let i = 0; i < count; i++) {
  const ok = init(i, 1); // BASS_ASIO_THREAD = 1
  if (!ok) { console.log(`  [${i}] init 失败`); continue; }
  const inf = { name: Array(32).fill(0), version: 0, inputs: 0, outputs: 0, bufmin: 0, bufmax: 0, bufpref: 0, bufgran: 0 };
  const r = getInfo(inf);
  const regName = regNames[i] || '(未知)';
  console.log(`  [${i}] reg="${regName}" init=ok info=${r} in=${inf.inputs} out=${inf.outputs} ` +
              `ver=0x${inf.version.toString(16)} buf=${inf.bufmin}/${inf.bufpref}/${inf.bufmax} gran=${inf.bufgran}`);
  free();
}
