/**
 * Worker API 客户端(网关 → cloud-mail /api/gateway/*)
 * 所有请求携带网关专用密钥,出错时做有限重试
 */
import config from './config.js';

const MAX_RETRY = 2;

async function request(path, options = {}, retry = 0) {
	const url = `${config.apiBase}/api${path}`;
	const headers = {
		Authorization: `Bearer ${config.gatewayKey}`,
		...(options.headers || {}),
	};

	let resp;
	try {
		resp = await fetch(url, { ...options, headers });
	} catch (e) {
		if (retry < MAX_RETRY) {
			return request(path, options, retry + 1);
		}
		throw new Error(`API 请求失败 ${url}: ${e.message}`);
	}

	if (!resp.ok) {
		throw new Error(`API ${resp.status}: ${url}`);
	}

	const body = await resp.json();
	if (body.code !== 200) {
		throw new Error(`API 业务错误 ${body.code}: ${body.msg || body.message || ''}`);
	}
	return body.data;
}

export default {
	/** IMAP/SMTP 登录校验:{ userId, email, accounts } */
	auth(email, password) {
		return request('/gateway/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password }),
		});
	},

	/** 邮箱目录 + 水位线:{ uidvalidity, latestEmailId, accounts } */
	mailboxes(userId) {
		return request(`/gateway/mailboxes?userId=${userId}`);
	},

	/** 邮件增量列表:{ list, latestEmailId } */
	emails(userId, folder, sinceEmailId = 0, limit = config.pageSize) {
		return request(
			`/gateway/emails?userId=${userId}&folder=${folder}&sinceEmailId=${sinceEmailId}&limit=${limit}`
		);
	},

	/** 取完整 MIME:{ emailId, mimeB64 } → 解码为 Buffer */
	async email(userId, emailId) {
		const data = await request(`/gateway/email/${emailId}?userId=${userId}`);
		return { emailId: data.emailId, mime: Buffer.from(data.mimeB64, 'base64') };
	},

	/** 更新状态:seen/starred/deleted */
	flags(userId, emailId, flags) {
		return request(`/gateway/email/${emailId}/flags`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId, ...flags }),
		});
	},

	/** 发信(SMTP 网关):提交完整 MIME(base64),Worker 解析+发送+回写 D1 */
	send(userId, mimeBuf) {
		return request('/gateway/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId, mimeB64: mimeBuf.toString('base64') }),
		});
	},

	/** 追加邮件(IMAP APPEND,客户端"已发送副本"):body { userId, folder, mimeB64 } */
	append(userId, folder, mimeBuf) {
		return request('/gateway/append', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId, folder, mimeB64: mimeBuf.toString('base64') }),
		});
	},
};
