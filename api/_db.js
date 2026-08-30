import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL);

/* 建表只在每个实例冷启动时执行一次，不再每次请求都跑 */
let ensured = false;
export async function ensureTable() {
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

/* 取客户端 IP（Vercel 会注入 x-forwarded-for） */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return String(xff).split(',')[0].trim() || 'unknown';
}

/* 简易频率限制：同一 IP 在 windowMinutes 分钟内超过 limit 次则拒绝 */
export async function rateLimit(ip, path, limit, windowMinutes) {
  await sql`INSERT INTO request_log (ip, path) VALUES (${ip}, ${path})`;
  const rows = await sql`SELECT count(*)::int AS n FROM request_log
    WHERE ip = ${ip} AND path = ${path} AND ts > NOW() - make_interval(mins => ${windowMinutes})`;
  /* 顺手以 2% 概率清理两天前的旧日志，防止表无限增长 */
  if (Math.random() < 0.02) {
    await sql`DELETE FROM request_log WHERE ts < NOW() - INTERVAL '2 days'`;
  }
  return rows[0].n <= limit;
}