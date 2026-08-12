/**
 * 网关配置(环境变量注入)
 * API_BASE_URL  - cloud-mail Worker 的 API 根地址(不含 /api 前缀)
 * GATEWAY_KEY   - Worker 端配置的网关专用密钥(与 wrangler.toml gateway_key 一致)
 * IMAP_PORT     - IMAP 监听端口(生产 993,开发可用 1143 明文)
 * TLS_CERT/TLS_KEY - 启用 TLS 时提供证书路径;不配置则以明文运行(仅开发)
 */
const config = {
	apiBase: (process.env.API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, ''),
	gatewayKey: process.env.GATEWAY_KEY || '',
	imapPort: Number(process.env.IMAP_PORT || 1143),
	tlsCert: process.env.TLS_CERT || '',
	tlsKey: process.env.TLS_KEY || '',
	idlePollMs: Number(process.env.IDLE_POLL_MS || 30000),
	pageSize: Number(process.env.PAGE_SIZE || 100),
};

if (!config.gatewayKey) {
	console.warn('[config] 警告:GATEWAY_KEY 未配置,网关将无法通过 Worker 鉴权');
}

export default config;
