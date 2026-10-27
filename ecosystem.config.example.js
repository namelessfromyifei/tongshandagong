// 通山打拱 · PM2 部署配置示例
// 复制为 ecosystem.config.js 后填入真实值（该文件已在 .gitignore 中，不会提交）：
//   cp ecosystem.config.example.js ecosystem.config.js
//   生成 SESSION_SECRET：openssl rand -hex 32
//   pm2 start ecosystem.config.js && pm2 save

module.exports = {
  apps: [{
    name: 'tongshandagong',
    script: 'server.js',
    cwd: '/opt/tongshandagong',
    env: {
      NODE_ENV: 'production',
      PORT: 8080,

      // 微信公众号（已认证服务号）
      WX_APPID: 'wx_REPLACE_WITH_YOUR_APPID',
      WX_APPSECRET: 'REPLACE_WITH_YOUR_APPSECRET',
      // 必须与公众号「网页授权域名」完全一致，且带 https://
      WX_OAUTH_BASE: 'https://www.zhangyuning.xyz',

      // 固定随机字符串：openssl rand -hex 32
      SESSION_SECRET: 'REPLACE_WITH_OPENSSL_RAND_HEX_32',

      // GitHub Webhook 签名密钥（/webhook 自动部署校验，需与 GitHub 后台配置一致）
      WEBHOOK_SECRET: 'REPLACE_WITH_YOUR_WEBHOOK_SECRET',

      // 可选：跨域来源白名单（逗号分隔；留空=开放）
      // ALLOWED_ORIGINS: 'https://www.zhangyuning.xyz',

      // 可选：保持默认即可
      ROOM_IDLE_KICK_MS: 300000,
      OFFLINE_KICK_MS: 180000,
      AI_TURN_MS: 1500,
    },
  }],
};
