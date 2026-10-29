// 通山打拱 · PM2 部署配置示例
// 复制为 ecosystem.config.js 后填入真实值（该文件已在 .gitignore 中，不会提交）：
//   cp ecosystem.config.example.js ecosystem.config.js
//   生成 SESSION_SECRET：openssl rand -hex 32
//   pm2 start ecosystem.config.js && pm2 save

module.exports = {
  apps: [{
    name: 'tongshandagong',
    script: 'server.js',
    cwd: '/home/admin/tongshandagong',
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

      // GitHub Webhook 签名密钥（/webhook/deploy 自动部署校验，需与 GitHub 后台配置一致）
      // 复制为 ecosystem.config.js 时填入真实值（该文件已在 .gitignore 中，不会提交到仓库）
      WEBHOOK_SECRET: 'REPLACE_WITH_YOUR_WEBHOOK_SECRET',

      // 可选：跨域来源白名单（逗号分隔；留空=开放）
      // 上线域名后建议启用（待玩家全部切到域名再开，否则 http://IP:8080 直连会被拒）：
      // ALLOWED_ORIGINS: 'https://www.zhangyuning.xyz',

      // 可选：保持默认即可
      ROOM_IDLE_KICK_MS: 1800000, // 未开局/场结束 30 分钟闲置解散；局间（等下一局）不超时
      OFFLINE_KICK_WAIT_MS: 30000,   // 未开场/场末：非房主掉线满此值(ms)后房主可手动踢出（默认 30s）
      HOST_OFFLINE_KICK_MS: 300000,  // 未开场/场末：房主掉线超过此值(ms)自动移出（默认 5 分钟）
      REJOIN_TAKEOVER_MS: 30000, // 「网络波动」窗口：座主掉线超过此时长(ms)才允许他人手动重连顶替其座位（默认 30s）
      AI_TURN_MS: 1500,
    },
  }],
};
