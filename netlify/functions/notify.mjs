import { neon } from '@neondatabase/serverless';
import AlipaySdk from 'alipay-sdk';

const sql = neon(process.env.DATABASE_URL);

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
    /* 支付宝异步通知是 POST + form-urlencoded，先解析成对象 */
    const text = await req.text();
    const params = Object.fromEntries(new URLSearchParams(text));

    /* ① 验签：确认通知确实来自支付宝且未被篡改 */
    const sdk = getAlipay();
    const checker = sdk.checkNotifySignature || sdk.checkNotifySign;
    const pass = await checker.call(sdk, params);
    if (!pass) return new Response('fail');

    /* ② 核对通知是发给本应用的 */
    if (params.app_id !== process.env.ALIPAY_APP_ID) return new Response('fail');
    if (!params.out_trade_no) return new Response('fail');

    const st = params.trade_status;
    if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
      /* ③ 核对实付金额与订单金额一致 */
      const rows = await sql`SELECT amount FROM sites WHERE order_no = ${params.out_trade_no}`;
      if (!rows.length) return new Response('fail');
      if (Math.abs(Number(params.total_amount) - Number(rows[0].amount)) > 0.001) {
        console.error('金额不匹配', params.out_trade_no, params.total_amount, rows[0].amount);
        return new Response('fail');
      }
      /* 支付成功：进入待审核，不直接公开显示 */
      await sql`UPDATE sites SET status='pending_review', alipay_trade_no=${params.trade_no || ''}, paid_at=NOW()
        WHERE order_no=${params.out_trade_no} AND status='pending_payment'`;
    } else if (st === 'TRADE_CLOSED') {
      await sql`UPDATE sites SET status='closed' WHERE order_no=${params.out_trade_no} AND status='pending_payment'`;
    }
    return new Response('success');
  } catch (e) {
    console.error('notify error:', e);
    return new Response('fail');
  }
};