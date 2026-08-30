import { sql, ensureTable } from './_db.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: '方法不允许' });
    await ensureTable();
    const rows = await sql`
      SELECT title, url, description, amount, approved_at
      FROM sites WHERE status = 'approved'
      ORDER BY amount DESC, approved_at ASC`;
    const all = rows.map(r => ({ ...r, amount: Number(r.amount) }));
    const cap = 100;
    const sites = all.slice(0, cap);
    const waiting = await sql`SELECT count(*)::int AS n FROM sites WHERE status='pending_review'`;
    res.json({
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
    res.status(500).json({ error: '数据加载失败' });
  }
}