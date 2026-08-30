import AlipaySdk from 'alipay-sdk';

export const alipaySdk = new AlipaySdk({
  appId: process.env.ALIPAY_APP_ID,
  privateKey: process.env.ALIPAY_PRIVATE_KEY,        /* 应用私钥 */
  alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY,    /* 支付宝公钥（注意：不是应用公钥） */
  signType: 'RSA2',
  gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
});