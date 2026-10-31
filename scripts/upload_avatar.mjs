// 上传数字人形象图（需为已获授权的官方素材），把返回的 avatar id 写入 .env 的 AVATAR_ID。
// 用法：node scripts/upload_avatar.mjs <本地图片路径 | https://图片URL> [展示名]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const [src, name = '杨幂-授权形象'] = process.argv.slice(2);
if (!src) {
  console.error('用法：node scripts/upload_avatar.mjs <图片路径或URL> [展示名]');
  process.exit(1);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
let imageUri = src;
if (!/^https?:\/\//.test(src)) {
  const mime = MIME[path.extname(src).toLowerCase()];
  if (!mime) throw new Error('仅支持 PNG / JPG / JPEG / WEBP');
  imageUri = `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`;
}

const { VIDU_API_KEY, VIDU_HOST = 'api.vidu.cn' } = process.env;
const headers = { Authorization: `Token ${VIDU_API_KEY}`, 'Content-Type': 'application/json' };
const r = await fetch(`https://${VIDU_HOST}/live/v1/avatars`, {
  method: 'POST', headers, body: JSON.stringify({ image_uri: imageUri, name }),
});
let avatar = await r.json();
if (!r.ok) throw new Error(`上传失败 ${r.status}: ${JSON.stringify(avatar)}`);

// 等待平台生成形象描述
for (let i = 0; i < 180 && !['success', 'failed'].includes(avatar.status); i++) {
  await new Promise((res) => setTimeout(res, 2000));
  avatar = await (await fetch(`https://${VIDU_HOST}/live/v1/avatars/${avatar.id}`, { headers })).json();
}
console.log(`avatar ${avatar.id}: ${avatar.status}`);
if (avatar.status !== 'success') process.exit(1);

const envPath = fs.realpathSync(path.resolve(process.env.DOTENV_CONFIG_PATH || '.env'));
const lines = fs.readFileSync(envPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('AVATAR_ID='));
lines.push(`AVATAR_ID=${avatar.id}`);
fs.writeFileSync(envPath, lines.join('\n') + '\n');
console.log('已写入 .env: AVATAR_ID（注意：平台 90 天后自动删除图片，届时需重新上传）');
