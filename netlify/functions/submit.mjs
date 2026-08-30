import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import AlipaySdk from 'alipay-sdk';

const sql = neon(process.env.DATABASE_URL);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await sql`CREATE TABLE IF NOT EXISTS sites (
    id SERIAL PRIMARY KEY,
    order_no TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    amount NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment',
    alipay_trade_no TEXT,
    paid_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS request_log (
    id BIGSERIAL PRIMARY KEY,
    ip TEXT NOT NULL,
    path TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_request_log_ip ON request_log (ip, path, ts)`;
  ensured = true;
}

function clientIp(req) {
  /* x-nf-client-connection-ip 是 Netlify 记录的真实访客 IP */
  return req.headers.get('x-nf-client-connection-ip')
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || 'unknown';
}
async function rateLimit(ip, path, limit, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  await sql`INSERT INTO request_log (ip, path) VALUES (${ip}, ${path})`;
  const rows = await sql`SELECT count(*)::int AS n FROM request_log
    WHERE ip = ${ip} AND path = ${path} AND ts > ${since}`;
  if (Math.random() < 0.02) {
    await sql`DELETE FROM request_log WHERE ts < NOW() - INTERVAL '2 days'`;
  }
  return rows[0].n <= limit;
}

let _alipay = null;
function getAlipay() {
  if (!_alipay) {
    _alipay = new AlipaySdk({
      appId: process.env.ALIPAY_APP_ID,
      privateKey: process.env.ALIPAY_PRIVATE_KEY,
      alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY,
      signType: 'RSA2',
      gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
    });
  }
  return _alipay;
}

export default async (req) => {
  try {
    if (req.method !== 'POST') return json({ error: '方法不允许' }, 405);
    await ensureTable();

    /* 频率限制：同一 IP 每小时最多 10 次提交 */
    if (!(await rateLimit(clientIp(req), 'submit', 10, 60))) {
      return json({ error: '提交太频繁，请 1 小时后再试' }, 429);
    }

    let body = {};
    try { body = await req.json(); } catch {}

    /* 输入先转字符串、截断长度，再校验 */
    const title = String(body?.title ?? '').trim().slice(0, 30);
    const description = String(body?.description ?? '').trim().slice(0, 60);
    const contact = String(body?.contact ?? '').trim().slice(0, 100);
    let url = String(body?.url ?? '').trim();
    const amount = Math.round(Number(body?.amount) * 100) / 100;

    const errors = [];
    if (title.length < 2) errors.push('网站名称至少 2 个字');
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (url.length > 500) errors.push('网址过长');
    try { if (!new URL(url).hostname.includes('.')) throw 0; } catch { errors.push('网址格式不正确'); }
    if (!Number.isFinite(amount) || amount < 5 || amount > 100000) errors.push('出价需在 ¥5 – ¥100,000 之间');
    if (contact.length < 3) errors.push('请填写联系方式');
    if (errors.length) return json({ error: errors.join('；') }, 400);

    /* 榜单满员时：出价必须高于末位 */
    const cnt = await sql`SELECT count(*)::int AS n FROM sites WHERE status='approved'`;
    if (cnt[0].n >= 100) {
      const tail = await sql`SELECT amount FROM sites WHERE status='approved' ORDER BY amount DESC, approved_at ASC LIMIT 1 OFFSET 99`;
      const need = Number(tail[0].amount);
      if (amount <= need) return json({ error: `榜单已满，出价需高于 ¥${need} 才能上榜` }, 400);
    }

    /* 高熵订单号（UUID），无法被枚举猜测 */
    const orderNo = 'JB' + crypto.randomUUID().replace(/-/g, '').toUpperCase();
    await sql`INSERT INTO sites (order_no, title, url, description, contact, amount)
      VALUES (${orderNo}, ${title}, ${url}, ${description}, ${contact}, ${amount.toFixed(2)})`;

    /* 生成支付宝电脑网站支付跳转链接 */
    const payUrl = await getAlipay().pageExec('alipay.trade.page.pay', {
      method: 'GET',
      notifyUrl: process.env.BASE_URL + '/api/notify',
      returnUrl: process.env.BASE_URL + '/?paid=' + orderNo,
      bizContent: {
        out_trade_no: orderNo,
        total_amount: amount.toFixed(2),
        subject: '金榜上榜-' + title,
        product_code: 'FAST_INSTANT_TRADE_PAY',
      },
    });
    return json({ payUrl, orderNo });
  } catch (e) {
    console.error('submit error:', e);
    return json({ error: '下单失败，请稍后再试' }, 500);
  }
};