import { neon } from '@neondatabase/serverless';
import { AlipaySdk } from 'alipay-sdk';

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
  return req.headers.get('x-nf-client-connection-ip')
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || 'unknown';
}
async function rateLimit(ip, path, limit, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  await sql`INSERT INTO request_log (ip, path) VALUES (${ip}, ${path})`;
  const rows = await sql`SELECT count(*)::int AS n FROM request_log
    WHERE ip = ${ip} AND path = ${path} AND ts > ${since}`;
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
    const orderNo = new URL(req.url, 'http://localhost').searchParams.get('order_no') || '';
    /* 订单号格式白名单：必须是我们生成的 34 位编号 */
    if (!/^JB[0-9A-F]{32}$/.test(orderNo)) return json({ error: '订单号格式错误' }, 400);
    await ensureTable();
    if (!(await rateLimit(clientIp(req), 'order', 120, 10))) {
      return json({ error: '查询太频繁，请稍后再试' }, 429);
    }

    const rows = await sql`SELECT status, title, amount FROM sites WHERE order_no=${orderNo}`;
    if (!rows.length) return json({ error: '订单不存在' }, 404);
    let status = rows[0].status;

    /* 若异步通知尚未到达，主动向支付宝补查一次（同样核对金额） */
    if (status === 'pending_payment') {
      try {
        const r = await getAlipay().exec('alipay.trade.query', { bizContent: { out_trade_no: orderNo } });
        if (r && (r.tradeStatus === 'TRADE_SUCCESS' || r.tradeStatus === 'TRADE_FINISHED')) {
          if (Math.abs(Number(r.totalAmount) - Number(rows[0].amount)) <= 0.001) {
            await sql`UPDATE sites SET status='pending_review', alipay_trade_no=${r.tradeNo || ''}, paid_at=NOW()
              WHERE order_no=${orderNo} AND status='pending_payment'`;
            status = 'pending_review';
          }
        }
      } catch {}
    }
    return json({ status, title: rows[0].title, amount: Number(rows[0].amount) });
  } catch (e) {
    console.error('order error:', e);
    return json({ error: '查询失败' }, 500);
  }
};
