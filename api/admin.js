import crypto from 'node:crypto';
import { sql, ensureTable, rateLimit, clientIp } from './_db.js';

/* 常量时间密码比较，避免时序侧信道 */
function passwordOk(input) {
  const real = String(process.env.ADMIN_PASSWORD || '');
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: '方法不允许' });
    await ensureTable();

    /* ① 同一 IP 每小时最多 60 次调用，大幅拖慢密码爆破（批量审核不够用就调大这个 60） */
    if (!(await rateLimit(clientIp(req), 'admin', 60, 60))) {
      return res.status(429).json({ error: '操作太频繁，请 1 小时后再试' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { password, action, id } = body || {};

    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: '未配置 ADMIN_PASSWORD 环境变量' });
    if (!passwordOk(password)) return res.status(401).json({ error: '密码错误' });

    if (action === 'list') {
      const pending = await sql`SELECT id, title, url, description, contact, amount, paid_at
        FROM sites WHERE status='pending_review' ORDER BY paid_at DESC`;
      const approved = await sql`SELECT id, title, url, amount, approved_at
        FROM sites WHERE status='approved' ORDER BY amount DESC LIMIT 200`;
      const rejected = await sql`SELECT id, title, url, amount, approved_at
        FROM sites WHERE status='rejected' ORDER BY approved_at DESC LIMIT 100`;
      return res.json({ pending, approved, rejected });
    }
    if (action === 'approve' && id) {
      await sql`UPDATE sites SET status='approved', approved_at=NOW() WHERE id=${Number(id)} AND status='pending_review'`;
      return res.json({ ok: true });
    }
    if (action === 'reject' && id) {
      await sql`UPDATE sites SET status='rejected', approved_at=NOW() WHERE id=${Number(id)} AND status='pending_review'`;
      return res.json({ ok: true });
    }
    res.status(400).json({ error: '未知操作' });
  } catch (e) {
    console.error('admin error:', e);
    res.status(500).json({ error: '操作失败' });
  }
}