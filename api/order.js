import { sql, ensureTable, rateLimit, clientIp } from './_db.js';
import { alipaySdk } from './_alipay.js';

export default async function handler(req, res) {
  try {
    const orderNo = new URL(req.url, 'http://x').searchParams.get('order_no') || '';
    /* ① 订单号格式白名单：必须是我们生成的 34 位编号，直接挡掉乱猜的扫描请求 */
    if (!/^JB[0-9A-F]{32}$/.test(orderNo)) return res.status(400).json({ error: '订单号格式错误' });
    await ensureTable();

    /* ② 轻量限流：防批量枚举探测 */
    if (!(await rateLimit(clientIp(req), 'order', 120, 10))) {
      return res.status(429).json({ error: '查询太频繁，请稍后再试' });
    }

    const rows = await sql`SELECT status, title, amount FROM sites WHERE order_no=${orderNo}`;
    if (!rows.length) return res.status(404).json({ error: '订单不存在' });
    let status = rows[0].status;

    /* 若异步通知尚未到达，主动向支付宝补查一次（同样核对金额） */
    if (status === 'pending_payment') {
      try {
        const r = await alipaySdk.exec('alipay.trade.query', { bizContent: { out_trade_no: orderNo } });
        if (r && (r.tradeStatus === 'TRADE_SUCCESS' || r.tradeStatus === 'TRADE_FINISHED')) {
          if (Math.abs(Number(r.totalAmount) - Number(rows[0].amount)) <= 0.001) {
            await sql`UPDATE sites SET status='pending_review', alipay_trade_no=${r.tradeNo || ''}, paid_at=NOW()
              WHERE order_no=${orderNo} AND status='pending_payment'`;
            status = 'pending_review';
          }
        }
      } catch {}
    }
    res.json({ status, title: rows[0].title, amount: Number(rows[0].amount) });
  } catch (e) {
    console.error('order error:', e);
    res.status(500).json({ error: '查询失败' });
  }
}