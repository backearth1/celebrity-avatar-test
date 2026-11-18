// 上传数字人形象图（需为已获授权的官方素材），把返回的 avatar id 写入 .env。
// 用法：node scripts/upload_avatar.mjs <本地图片路径 | https://图片URL> [展示名] [写入的环境变量名]
// 默认写 AVATAR_ID（杨幂）；其他人设要写各自的名字，例如 John Wick 用 JOHN_AVATAR_ID，
// 否则会把全局形象覆盖掉，杨幂也变成他。
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const [src, name = '杨幂-授权形象', envKey = 'AVATAR_ID'] = process.argv.slice(2);
if (!src) {
  console.error('用法：node scripts/upload_avatar.mjs <图片路径或URL> [展示名] [环境变量名，默认 AVATAR_ID]');
  process.exit(1);
}
if (!/^[A-Z0-9_]+$/.test(envKey)) {
  console.error(`环境变量名不合法：${envKey}`);
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
const lines = fs.readFileSync(envPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith(`${envKey}=`));
lines.push(`${envKey}=${avatar.id}`);
fs.writeFileSync(envPath, lines.join('\n') + '\n');
console.log(`已写入 .env: ${envKey}（注意：平台 90 天后自动删除图片，届时需重新上传）`);
