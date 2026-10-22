/**
 * 扫码登录助手
 * 用法:
 *   node tools/qr-login.js new     生成二维码 → qr.png
 *   node tools/qr-login.js check   查询扫码状态（800过期/801待扫/802已扫待确认/803成功）
 *   node tools/qr-login.js account 查看当前登录账号
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.YW_API_BASE || 'http://127.0.0.1:3000';

async function get(pathname) {
  const res = await fetch(BASE + pathname, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${pathname}`);
  return res.json();
}

async function newQr() {
  const k = await get('/login/qr/key?timestamp=' + Date.now());
  const key = (k.data && k.data.unikey) || '';
  if (!key) throw new Error('拿不到 unikey: ' + JSON.stringify(k).slice(0, 200));

  const c = await get(`/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true&timestamp=${Date.now()}`);
  const b64 = String((c.data && c.data.qrimg) || '').replace(/^data:image\/png;base64,/, '');
  if (!b64) throw new Error('拿不到 qrimg');

  fs.writeFileSync(path.join(ROOT, 'qr.png'), Buffer.from(b64, 'base64'));
  fs.writeFileSync(path.join(ROOT, '.qr-key'), key);
  console.log('二维码已生成: qr.png');
  console.log('key =', key);
  console.log('qrurl =', (c.data && c.data.qrurl) || '(无)');
}

async function check() {
  const key = fs.readFileSync(path.join(ROOT, '.qr-key'), 'utf8').trim();
  const j = await get(`/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`);
  const map = { 800: '二维码已过期', 801: '等待扫码', 802: '已扫码，等待手机确认', 803: '登录成功' };
  console.log(`code=${j.code} · ${map[j.code] || j.message || ''}`);
  return j.code;
}

async function account() {
  const j = await get('/user/account?timestamp=' + Date.now());
  if (j.profile) {
    console.log('uid      =', j.profile.userId);
    console.log('nickname =', j.profile.nickname);
    console.log('vipType  =', j.profile.vipType);
    console.log('avatar   =', j.profile.avatarUrl);
  } else {
    console.log('未登录:', JSON.stringify(j).slice(0, 300));
  }
}

(async () => {
  const cmd = process.argv[2] || 'new';
  try {
    if (cmd === 'new') await newQr();
    else if (cmd === 'check') { const c = await check(); process.exit(c === 803 ? 0 : 0); }
    else if (cmd === 'account') await account();
    else console.log('用法: new | check | account');
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(1);
  }
})();
