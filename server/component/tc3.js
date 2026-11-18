// 腾讯云 API 3.0 签名（TC3-HMAC-SHA256）。
// SecretId 只进 Credential 标识身份，Signature 必须用 SecretKey 计算——
// 所以只给 SecretId 是签不出来的（实测返回 AuthFailure.SignatureFailure）。
import crypto from 'node:crypto';

export function sign({ secretId, secretKey, host, service, action, version, region, payload, timestamp }) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10); // UTC 日期
  const body = JSON.stringify(payload ?? {});

  // 1. 规范请求串
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedPayload = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');

  // 2. 待签名字符串
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = ['TC3-HMAC-SHA256', ts, credentialScope, hashedCanonical].join('\n');

  // 3. 逐级派生签名密钥
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
  const kDate = hmac(`TC3${secretKey}`, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}/`,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(ts),
      ...(region ? { 'X-TC-Region': region } : {}),
    },
    body,
  };
}

// 调用任意腾讯云 API 3.0 接口
export async function callTc({ secretId, secretKey, host, service, action, version, region, payload, timeoutMs = 20000 }) {
  const { url, headers, body } = sign({ secretId, secretKey, host, service, action, version, region, payload });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: r.status, data: data.Response || data };
  } finally {
    clearTimeout(timer);
  }
}
