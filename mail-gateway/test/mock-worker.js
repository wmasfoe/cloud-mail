/**
 * mock Worker 服务器:模拟 cloud-mail 的 /api/gateway/* 接口(开发验证用)
 * 内置 1 个用户 + 4 封测试邮件(含中文主题/HTML/附件)
 */
import http from 'node:http';

const GATEWAY_KEY = 'test-key';
const PORT = 8787;

const USERS = {
	'user@example.com': { password: 'pass123', userId: 1 },
};

const ACCOUNTS = [
	{ accountId: 1, userId: 1, email: 'user@example.com' },
	{ accountId: 2, userId: 1, email: 'admin@example.com' },
];

const MIME = (from, to, subject, date, msgId, bodyHtml, extra = '') =>
	`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${msgId}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8${extra}\r\n\r\n${bodyHtml}`;

// emailId 从 101 开始(模拟真实自增)
const EMAILS = [
	{
		emailId: 101, userId: 1, accountId: 1, type: 0, unread: 1, isDel: 0,
		subject: 'Welcome to cloud-mail', sendEmail: 'no-reply@example.com', name: 'Cloud Mail',
		toEmail: 'user@example.com', createTime: '2026-08-01 08:00:00', starred: 0,
		mime: MIME('no-reply@example.com', 'user@example.com', 'Welcome to cloud-mail',
			'Sat, 01 Aug 2026 08:00:00 +0000', '<welcome@example.com>',
			'<h1>Welcome!</h1><p>Hello and welcome to cloud-mail.</p>'),
	},
	{
		emailId: 102, userId: 1, accountId: 2, type: 0, unread: 0, isDel: 0,
		subject: '=?utf-8?B?5ZGo5L2T5Lya6K6h5YiS?=', sendEmail: 'friend@gmail.com', name: '朋友',
		toEmail: 'admin@example.com', createTime: '2026-08-05 12:30:00', starred: 1,
		mime: MIME('朋友 <friend@gmail.com>', 'admin@example.com', '=?utf-8?B?5ZGo5L2T5Lya6K6h5YiS?=',
			'Wed, 05 Aug 2026 12:30:00 +0800', '<abc123@mail.gmail.com>',
			'<p>这是中文测试邮件,包含<strong>粗体</strong>和<a href="https://example.com">链接</a>。</p>'),
	},
	{
		emailId: 103, userId: 1, accountId: 1, type: 0, unread: 0, isDel: 0,
		subject: 'Meeting notes', sendEmail: 'boss@corp.com', name: 'Boss',
		toEmail: 'user@example.com', createTime: '2026-08-10 09:15:00', starred: 0,
		mime: MIME('Boss <boss@corp.com>', 'user@example.com', 'Meeting notes',
			'Mon, 10 Aug 2026 09:15:00 +0000', '<meet@corp.com>',
			'<p>Please review the attached notes.</p>'),
	},
	{
		emailId: 104, userId: 1, accountId: 1, type: 1, unread: 1, isDel: 0,
		subject: 'Re: Meeting notes', sendEmail: 'user@example.com', name: 'user',
		toEmail: 'boss@corp.com', createTime: '2026-08-11 10:00:00', starred: 0,
		mime: MIME('user <user@example.com>', 'boss@corp.com', 'Re: Meeting notes',
			'Tue, 11 Aug 2026 10:00:00 +0000', '<sent-104@cloud-mail>',
			'<p>Got it, thanks!</p>'),
	},
];

const FLAGS_STORE = new Map(); // emailId -> {seen, starred, deleted}

function json(res, data, code = 200) {
	const body = JSON.stringify({ code, data });
	res.writeHead(code, { 'Content-Type': 'application/json' });
	res.end(body);
}

function fail(res, message, httpCode = 200) {
	const body = JSON.stringify({ code: httpCode, msg: message });
	res.writeHead(httpCode, { 'Content-Type': 'application/json' });
	res.end(body);
}

function authCheck(req, res) {
	const auth = req.headers.authorization || '';
	const key = auth.replace(/^Bearer\s+/i, '');
	if (key !== GATEWAY_KEY) {
		res.writeHead(401);
		res.end(JSON.stringify({ code: 401, msg: 'Unauthorized' }));
		return false;
	}
	return true;
}

function readBody(req) {
	return new Promise(resolve => {
		let data = '';
		req.on('data', chunk => (data += chunk));
		req.on('end', () => {
			try { resolve(JSON.parse(data)); } catch { resolve({}); }
		});
	});
}

const server = http.createServer(async (req, res) => {
	if (!authCheck(req, res)) return;
	const url = new URL(req.url, 'http://localhost');
	const path = url.pathname;

	if (req.method === 'POST' && path === '/api/gateway/auth') {
		const { email, password } = await readBody(req);
		const user = USERS[email];
		if (!user || user.password !== password) {
			return json(res, null, 401);
		}
		return json(res, {
			userId: user.userId,
			email,
			accounts: ACCOUNTS.filter(a => a.userId === user.userId),
		});
	}

	if (req.method === 'GET' && path === '/api/gateway/mailboxes') {
		const userId = Number(url.searchParams.get('userId'));
		const all = EMAILS.filter(e => e.userId === userId && e.isDel === 0);
		const maxId = all.reduce((m, e) => Math.max(m, e.emailId), 0);
		return json(res, {
			uidvalidity: userId,
			latestEmailId: maxId,
			accounts: ACCOUNTS.filter(a => a.userId === userId),
		});
	}

	if (req.method === 'GET' && path === '/api/gateway/emails') {
		const userId = Number(url.searchParams.get('userId'));
		const folder = url.searchParams.get('folder') || 'inbox';
		const sinceEmailId = Number(url.searchParams.get('sinceEmailId') || 0);
		const limit = Number(url.searchParams.get('limit') || 100);
		const type = folder === 'sent' ? 1 : 0;
		const list = EMAILS
			.filter(e => e.userId === userId && e.type === type && e.isDel === 0 && e.emailId > sinceEmailId)
			.sort((a, b) => a.emailId - b.emailId)
			.slice(0, limit)
			.map(e => ({
				emailId: e.emailId,
				unread: e.unread,
				subject: e.subject,
				sendEmail: e.sendEmail,
				name: e.name,
				toEmail: e.toEmail,
				createTime: e.createTime,
				starred: e.starred,
			}));
		return json(res, {
			list,
			latestEmailId: list.length ? list[list.length - 1].emailId : sinceEmailId,
		});
	}

	const emailMatch = path.match(/^\/api\/gateway\/email\/(\d+)$/);
	if (req.method === 'GET' && emailMatch) {
		const emailId = Number(emailMatch[1]);
		const email = EMAILS.find(e => e.emailId === emailId);
		if (!email) return json(res, { code: 404, msg: 'email not found' });
		return json(res, { emailId, mime: email.mime });
	}

	const flagsMatch = path.match(/^\/api\/gateway\/email\/(\d+)\/flags$/);
	if (req.method === 'POST' && flagsMatch) {
		const emailId = Number(flagsMatch[1]);
		const body = await readBody(req);
		FLAGS_STORE.set(emailId, body);
		return json(res, {});
	}

	res.writeHead(404);
	res.end(JSON.stringify({ code: 404, msg: `unknown path ${path}` }));
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[mock-worker] listening on http://127.0.0.1:${PORT}`);
	console.log(`[mock-worker] 用户: user@example.com / pass123`);
	console.log(`[mock-worker] 邮件: ${EMAILS.length} 封(101-104)`);
});
