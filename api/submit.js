import crypto from 'node:crypto';
import { sql, ensureTable, rateLimit, clientIp } from './_db.js';
import { alipaySdk } from './_alipay.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: '方法不允许' });
    await ensureTable();

    /* ① 频率限制：同一 IP 每小时最多 10 次提交，防脚本灌库 */
    if (!(await rateLimit(clientIp(req), 'submit', 10, 60))) {
      return res.status(429).json({ error: '提交太频繁，请 1 小时后再试' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

    /* ② 所有输入先转字符串并截断长度，再校验，杜绝超大 payload */
    const title = String(body?.title ?? '').trim().slice(0, 30);
    const description = String(body?.description ?? '').trim().slice(0, 60);
    const contact = String(body?.contact ?? '').trim().slice(0, 100);
    let url = String(body?.url ?? '').trim();
    /* ③ 金额归一到"分"，杜绝 5.999 这类精度不一致 */
    const amount = Math.round(Number(body?.amount) * 100) / 100;

    const errors = [];
    if (title.length < 2) errors.push('网站名称至少 2 个字');
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (url.length > 500) errors.push('网址过长');
    try { if (!new URL(url).hostname.includes('.')) throw 0; } catch { errors.push('网址格式不正确'); }
    if (!Number.isFinite(amount) || amount < 5 || amount > 100000) errors.push('出价需在 ¥5 – ¥100,000 之间');
    if (contact.length < 3) errors.push('请填写联系方式');
    if (errors.length) return res.status(400).json({ error: errors.join('；') });

    /* 榜单满员时：出价必须高于末位 */
    const cnt = await sql`SELECT count(*)::int AS n FROM sites WHERE status='approved'`;
    if (cnt[0].n >= 100) {
      const tail = await sql`SELECT amount FROM sites WHERE status='approved' ORDER BY amount DESC, approved_at ASC LIMIT 1 OFFSET 99`;
      const need = Number(tail[0].amount);
      if (amount <= need) return res.status(400).json({ error: `榜单已满，出价需高于 ¥${need} 才能上榜` });
    }

    /* ④ 订单号改用完整 UUID（122 位随机熵），无法被枚举猜测 */
    const orderNo = 'JB' + crypto.randomUUID().replace(/-/g, '').toUpperCase();

    await sql`INSERT INTO sites (order_no, title, url, description, contact, amount)
      VALUES (${orderNo}, ${title}, ${url}, ${description}, ${contact}, ${amount.toFixed(2)})`;

    const payUrl = await alipaySdk.pageExec('alipay.trade.page.pay', {
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
    res.json({ payUrl, orderNo });
  } catch (e) {
    console.error('submit error:', e);                        /* 详细错误只进日志 */
    res.status(500).json({ error: '下单失败，请稍后再试' });   /* 用户只看通用提示 */
  }
}