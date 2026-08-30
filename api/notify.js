import querystring from 'node:querystring';
import { sql } from './_db.js';
import { alipaySdk } from './_alipay.js';

async function readParams(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  if (typeof req.body === 'string' && req.body) return querystring.parse(req.body);
  let raw = '';
  await new Promise(resolve => {
    if (req.readableEnded) return resolve();
    req.on('data', c => raw += c);
    req.on('end', resolve);
    setTimeout(resolve, 3000);
  });
  return querystring.parse(raw);
}

export default async function handler(req, res) {
  try {
    const params = await readParams(req);

    /* ① 验签：确认通知确实来自支付宝且未被篡改 */
    const checker = alipaySdk.checkNotifySignature || alipaySdk.checkNotifySign;
    const pass = await checker.call(alipaySdk, params);
    if (!pass) return res.send('fail');

    /* ② 核对通知是发给本应用的，且带有关键字段 */
    if (params.app_id !== process.env.ALIPAY_APP_ID) return res.send('fail');
    if (!params.out_trade_no) return res.send('fail');

    const st = params.trade_status;
    if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
      /* ③ 核对实付金额与订单金额一致（支付宝官方文档要求的四项核对之一） */
      const rows = await sql`SELECT amount FROM sites WHERE order_no = ${params.out_trade_no}`;
      if (!rows.length) return res.send('fail');
      if (Math.abs(Number(params.total_amount) - Number(rows[0].amount)) > 0.001) {
        console.error('金额不匹配', params.out_trade_no, params.total_amount, rows[0].amount);
        return res.send('fail');
      }
      /* 支付成功：进入待审核，不直接公开显示 */
      await sql`UPDATE sites SET status='pending_review', alipay_trade_no=${params.trade_no || ''}, paid_at=NOW()
        WHERE order_no=${params.out_trade_no} AND status='pending_payment'`;
    } else if (st === 'TRADE_CLOSED') {
      await sql`UPDATE sites SET status='closed' WHERE order_no=${params.out_trade_no} AND status='pending_payment'`;
    }
    res.send('success');
  } catch (e) {
    console.error('notify error:', e);
    res.send('fail');
  }
}