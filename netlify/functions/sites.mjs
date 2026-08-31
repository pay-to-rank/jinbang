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

export default async (req) => {
  try {
    if (req.method !== 'GET') return json({ error: '方法不允许' }, 405);
    await ensureTable();
    const rows = await sql`
      SELECT title, url, description, amount, paid_at
      FROM sites WHERE status = 'approved'
      ORDER BY amount DESC, paid_at ASC`;
    const all = rows.map(r => ({ ...r, amount: Number(r.amount) }));
    const cap = 100;
    const sites = all.slice(0, cap);
    const waiting = await sql`SELECT count(*)::int AS n FROM sites WHERE status='pending_review'`;
    return json({
      sites,
      stats: {
        count: sites.length,
        total: all.reduce((s, r) => s + r.amount, 0),
        threshold: all.length >= cap ? all[cap - 1].amount : 5,
        cap, waiting: waiting[0].n,
      },
    });
  } catch (e) {
    console.error('sites error:', e);
    return json({ error: '数据加载失败' }, 500);
  }
};
