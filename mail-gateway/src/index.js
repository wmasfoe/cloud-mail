/**
 * mail-gateway 入口:启动 IMAP 服务(生产 993 TLS,开发 1143 明文)
 */
import config from './config.js';
import { createServer } from './imap.js';

const server = createServer();

server.listen(config.imapPort, '0.0.0.0', () => {
	const mode = config.tlsCert ? 'TLS' : '明文(仅开发)';
	console.log(`[gateway] IMAP 服务已启动:端口 ${config.imapPort} (${mode})`);
	console.log(`[gateway] Worker API: ${config.apiBase}`);
});
