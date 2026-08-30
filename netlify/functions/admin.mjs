import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

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
  if (Math.random() < 0.02) {
    await sql`DELETE FROM request_log WHERE ts < NOW() - INTERVAL '2 days'`;
  }
  return rows[0].n <= limit;
}

/* 常量时间密码比较，避免时序侧信道 */
function passwordOk(input) {
  const real = String(process.env.ADMIN_PASSWORD || '');
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  try {
    if (req.method !== 'POST') return json({ error: '方法不允许' }, 405);
    await ensureTable();
    /* 同一 IP 每小时最多 60 次调用，拖慢密码爆破（批量审核不够用就调大这个 60） */
    if (!(await rateLimit(clientIp(req), 'admin', 60, 60))) {
      return json({ error: '操作太频繁，请 1 小时后再试' }, 429);
    }

    let body = {};
    try { body = await req.json(); } catch {}
    const { password, action, id } = body || {};

    if (!process.env.ADMIN_PASSWORD) return json({ error: '未配置 ADMIN_PASSWORD 环境变量' }, 500);
    if (!passwordOk(password)) return json({ error: '密码错误' }, 401);

    if (action === 'list') {
      const pending = await sql`SELECT id, title, url, description, contact, amount, paid_at
        FROM sites WHERE status='pending_review' ORDER BY paid_at DESC`;
      const approved = await sql`SELECT id, title, url, amount, approved_at
        FROM sites WHERE status='approved' ORDER BY amount DESC LIMIT 200`;
      const rejected = await sql`SELECT id, title, url, amount, approved_at
        FROM sites WHERE status='rejected' ORDER BY approved_at DESC LIMIT 100`;
      return json({ pending, approved, rejected });
    }
    if (action === 'approve' && id) {
      await sql`UPDATE sites SET status='approved', approved_at=NOW() WHERE id=${Number(id)} AND status='pending_review'`;
      return json({ ok: true });
    }
    if (action === 'reject' && id) {
      await sql`UPDATE sites SET status='rejected', approved_at=NOW() WHERE id=${Number(id)} AND status='pending_review'`;
      return json({ ok: true });
    }
    return json({ error: '未知操作' }, 400);
  } catch (e) {
    console.error('admin error:', e);
    return json({ error: '操作失败' }, 500);
  }
};