import app from '../hono/hono';
import result from '../model/result';
import userService from '../service/user-service';
import attService from '../service/att-service';
import emailService from '../service/email-service';
import cryptoUtils from '../utils/crypto-utils';
import constant from '../const/constant';
import { isDel, emailConst, userConst } from '../const/entity-const';
import orm from '../entity/orm';
import account from '../entity/account';
import email from '../entity/email';
import user from '../entity/user';
import { star } from '../entity/star';
import { and, eq, gt, asc, inArray, sql } from 'drizzle-orm';
import PostalMime from 'postal-mime';

/**
 * IMAP/SMTP 网关专用接口(仅供 mail-gateway 调用)
 * 鉴权:Authorization: Bearer <GATEWAY_KEY>(env 配置),与网页端 JWT 体系完全隔离
 */
app.use('/gateway/*', async (c, next) => {
	const auth = c.req.header('authorization') || '';
	const key = auth.replace(/^Bearer\s+/i, '');
	// 兼容大小写:wrangler.toml 注释习惯用 gateway_key,环境变量名大小写敏感
	const gatewayKey = c.env.GATEWAY_KEY || c.env.gateway_key;
	if (!gatewayKey || key !== gatewayKey) {
		return c.json(result.fail('Unauthorized', 401));
	}
	return await next();
});

/**
 * 登录校验:网关收到 IMAP/SMTP LOGIN 时调用
 * 返回用户信息及其名下所有可用邮箱(account 列表)
 */
app.post('/gateway/auth', async (c) => {
	const { email, password } = await c.req.json();
	if (!email || !password) {
		return c.json(result.fail('email and password are required', 400));
	}

	let userRow = await userService.selectByEmailIncludeDel(c, email);
	if (!userRow || userRow.isDel === isDel.DELETE) {
		// 子邮箱登录:email 是 account,解析到所属用户(密码统一用主用户密码)
		const acc = await orm(c).select().from(account)
			.where(and(eq(account.email, email), eq(account.isDel, isDel.NORMAL)))
			.get();
		if (acc) {
			userRow = await orm(c).select().from(user).where(eq(user.userId, acc.userId)).get();
		}
	}
	if (!userRow || userRow.isDel === isDel.DELETE) {
		return c.json(result.fail('user not found', 401));
	}
	if (userRow.status === userConst.status.BAN) {
		return c.json(result.fail('user banned', 403));
	}
	if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
		return c.json(result.fail('incorrect password', 401));
	}

	const accountList = await orm(c).select({
		accountId: account.accountId,
		email: account.email
	}).from(account)
		.where(and(eq(account.userId, userRow.userId), eq(account.isDel, isDel.NORMAL)))
		.all();

	return c.json(result.ok({
		userId: userRow.userId,
		email: userRow.email,
		accounts: accountList
	}));
});

/**
 * 邮箱目录 + 水位线:网关 SELECT / IDLE 轮询时调用
 * UIDVALIDITY 用 userId(每个用户固定不变);UIDNEXT = 最新 email_id + 1(email_id 全局自增)
 */
app.get('/gateway/mailboxes', async (c) => {
	const userId = Number(c.req.query('userId'));
	if (!userId) {
		return c.json(result.fail('userId required', 400));
	}

	const accountList = await orm(c).select({
		accountId: account.accountId,
		email: account.email
	}).from(account)
		.where(and(eq(account.userId, userId), eq(account.isDel, isDel.NORMAL)))
		.all();

	const latest = await orm(c).select({ maxId: sql`max(${email.emailId})` }).from(email)
		.where(and(eq(email.userId, userId), eq(email.isDel, isDel.NORMAL)))
		.get();

	return c.json(result.ok({
		uidvalidity: userId,
		latestEmailId: latest?.maxId || 0,
		accounts: accountList
	}));
});

/**
 * 邮件列表 / 增量拉取
 * folder: inbox(type=0) | sent(type=1);sinceEmailId 增量游标;limit 默认 100 上限 200
 * 返回按 email_id 升序的列表(附星标状态),latestEmailId 供网关记录水位线
 */
app.get('/gateway/emails', async (c) => {
	const userId = Number(c.req.query('userId'));
	const folder = c.req.query('folder') || 'inbox';
	const sinceEmailId = Number(c.req.query('sinceEmailId') || 0);
	const limit = Math.min(Number(c.req.query('limit') || 100), 200);
	if (!userId) {
		return c.json(result.fail('userId required', 400));
	}

	const type = folder === 'sent' ? emailConst.type.SEND : emailConst.type.RECEIVE;

	const list = await orm(c).select({
		emailId: email.emailId,
		unread: email.unread,
		subject: email.subject,
		sendEmail: email.sendEmail,
		name: email.name,
		toEmail: email.toEmail,
		createTime: email.createTime
	}).from(email)
		.where(and(
			eq(email.userId, userId),
			eq(email.type, type),
			eq(email.isDel, isDel.NORMAL),
			gt(email.emailId, sinceEmailId)
		))
		.orderBy(asc(email.emailId))
		.limit(limit)
		.all();

	const emailIds = list.map(item => item.emailId);
	if (emailIds.length > 0) {
		const starList = await orm(c).select({ emailId: star.emailId }).from(star)
			.where(and(eq(star.userId, userId), inArray(star.emailId, emailIds)))
			.all();
		const starMap = Object.fromEntries(starList.map(s => [s.emailId, true]));
		list.forEach(item => item.starred = !!starMap[item.emailId]);
	}

	return c.json(result.ok({
		list,
		latestEmailId: list.length ? list[list.length - 1].emailId : sinceEmailId
	}));
});

/**
 * 取完整邮件 RFC5322 MIME:
 * 1) 优先 R2 原始 MIME(raw/{emailId}.eml)
 * 2) 回退:用 D1 字段 + attachments 表组装(老邮件兼容)
 */
app.get('/gateway/email/:id', async (c) => {
	const userId = Number(c.req.query('userId'));
	const emailId = Number(c.req.param('id'));
	if (!userId || !emailId) {
		return c.json(result.fail('userId and email id required', 400));
	}

	const emailRow = await orm(c).select().from(email)
		.where(and(eq(email.emailId, emailId), eq(email.userId, userId)))
		.get();
	if (!emailRow) {
		return c.json(result.fail('email not found', 404));
	}

	const raw = await c.env.r2.get(constant.RAW_PREFIX + emailId + '.eml');
	if (raw) {
		return c.json(result.ok({ emailId, mime: await raw.text() }));
	}

	const attList = await attService.selectByEmailIds(c, [emailId]);
	const mime = await buildMimeFromRow(c, emailRow, attList);
	return c.json(result.ok({ emailId, mime }));
});

/**
 * 更新邮件状态(IMAP STORE):seen → unread;starred → star 表;deleted → is_del
 * body: { userId, seen?, starred?, deleted? }(缺省字段不修改)
 */
app.post('/gateway/email/:id/flags', async (c) => {
	const { userId, seen, starred, deleted } = await c.req.json();
	const emailId = Number(c.req.param('id'));
	if (!userId || !emailId) {
		return c.json(result.fail('userId and email id required', 400));
	}

	const emailRow = await orm(c).select().from(email)
		.where(and(eq(email.emailId, emailId), eq(email.userId, userId)))
		.get();
	if (!emailRow) {
		return c.json(result.fail('email not found', 404));
	}

	if (seen !== undefined) {
		await orm(c).update(email).set({ unread: seen ? emailConst.unread.READ : emailConst.unread.UNREAD })
			.where(eq(email.emailId, emailId)).run();
	}

	if (starred !== undefined) {
		if (starred) {
			await orm(c).insert(star).values({ userId, emailId })
				.onConflictDoNothing().run();
		} else {
			await orm(c).delete(star)
				.where(and(eq(star.userId, userId), eq(star.emailId, emailId))).run();
		}
	}

	if (deleted !== undefined) {
		await orm(c).update(email).set({ isDel: deleted ? isDel.DELETE : isDel.NORMAL })
			.where(eq(email.emailId, emailId)).run();
	}

	return c.json(result.ok());
});

/**
 * 用 D1 字段 + R2 附件组装 RFC5322 MIME(老邮件回退路径)
 */
async function buildMimeFromRow(c, emailRow, attList) {
	const headers = [];
	const from = emailRow.name ? `${encodeHeader(emailRow.name)} <${emailRow.sendEmail}>` : emailRow.sendEmail;
	headers.push(`From: ${from}`);
	if (emailRow.toEmail) {
		headers.push(`To: ${emailRow.toEmail}`);
	}
	if (emailRow.cc && emailRow.cc !== '[]') {
		const ccList = JSON.parse(emailRow.cc).map(item => item.address || item);
		if (ccList.length) headers.push(`Cc: ${ccList.join(', ')}`);
	}
	if (emailRow.subject) {
		headers.push(`Subject: ${encodeHeader(emailRow.subject)}`);
	}
	headers.push(`Date: ${formatDateHeader(emailRow.createTime)}`);
	headers.push(`Message-ID: ${emailRow.messageId || `<${emailRow.emailId}@cloud-mail>`}`);
	if (emailRow.inReplyTo) headers.push(`In-Reply-To: ${emailRow.inReplyTo}`);
	if (emailRow.relation) headers.push(`References: ${emailRow.relation}`);
	headers.push('MIME-Version: 1.0');

	const text = emailRow.text || '';
	const html = emailRow.content || '';

	if (!attList || attList.length === 0) {
		if (html) {
			const boundary = `----cloudmail${Date.now()}`;
			return headers.join('\r\n') + '\r\n'
				+ `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`
				+ `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`
				+ `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`
				+ `--${boundary}--\r\n`;
		}
		return headers.join('\r\n') + '\r\n'
			+ 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
			+ text + '\r\n';
	}

	// 有附件:multipart/mixed
	const boundary = `----cloudmail${Date.now()}`;
	const parts = [];
	parts.push(headers.join('\r\n'));
	parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"\r\n`);

	const altBoundary = `----cloudmail-alt${Date.now()}`;
	parts.push(`--${boundary}`);
	parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n`);
	parts.push(`--${altBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`);
	parts.push(`--${altBoundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`);
	parts.push(`--${altBoundary}--`);

	for (const att of attList) {
		parts.push(`--${boundary}`);
		parts.push(`Content-Type: ${att.mimeType || 'application/octet-stream'}`);
		parts.push(`Content-Disposition: ${att.disposition || 'attachment'}; filename="${att.filename || 'attachment'}"`);
		if (att.contentId) {
			parts.push(`Content-ID: ${att.contentId}`);
		}
		parts.push('Content-Transfer-Encoding: base64\r\n');
		const data = await readR2Base64(c, att.key);
		parts.push(data);
	}

	parts.push(`--${boundary}--`);
	return parts.join('\r\n');
}

async function readR2Base64(c, key) {
	const obj = await c.env.r2.get(key);
	if (!obj) {
		return '';
	}
	const buf = await obj.arrayBuffer();
	const bytes = new Uint8Array(buf);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function encodeHeader(value) {
	// RFC2047 编码非 ASCII 头字段
	if (/^[\x20-\x7e]*$/.test(value)) {
		return value;
	}
	return `=?utf-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

function formatDateHeader(createTime) {
	// D1 CURRENT_TIMESTAMP 为 'YYYY-MM-DD HH:MM:SS'(UTC),转为 RFC 2822 格式
	if (!createTime) {
		return new Date().toUTCString();
	}
	const normalized = createTime.includes('T') ? createTime : createTime.replace(' ', 'T') + 'Z';
	const date = new Date(normalized);
	return isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

/**
 * 发信(SMTP 网关调用):body { userId, mime }
 * 流程:解析 MIME → 校验 From 属于该用户名下邮箱 → 复用 emailService.send 发送并回写 D1
 * From 非名下邮箱 → 403(防伪造);发送走 CF Email Service(优先)/Resend(回退)
 */
app.post('/gateway/send', async (c) => {
	const { userId, mime } = await c.req.json();
	if (!userId || !mime) {
		return c.json(result.fail('userId and mime required', 400));
	}

	let parsed;
	try {
		parsed = await PostalMime.parse(mime);
	} catch (e) {
		return c.json(result.fail('invalid mime: ' + e.message, 400));
	}

	const fromAddress = parsed.from?.address;
	if (!fromAddress) {
		return c.json(result.fail('from address required', 400));
	}

	// 校验发件地址属于该用户(防伪造)
	const accountRow = await orm(c).select().from(account)
		.where(and(
			eq(account.userId, userId),
			eq(account.email, fromAddress),
			eq(account.isDel, isDel.NORMAL)
		))
		.get();
	if (!accountRow) {
		return c.json(result.fail('sender address not allowed: ' + fromAddress, 403));
	}

	const toList = (parsed.to || []).map(t => t.address);
	if (toList.length === 0) {
		return c.json(result.fail('no recipient', 400));
	}

	const attachments = (parsed.attachments || []).map(att => ({
		filename: att.filename,
		content: att.content,
		contentType: att.mimeType || 'application/octet-stream',
		contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') : undefined,
		disposition: att.disposition || (att.contentId ? 'inline' : 'attachment'),
	}));

	const [emailResult] = await emailService.send(c, {
		accountId: accountRow.accountId,
		name: parsed.from?.name || null,
		receiveEmail: toList,
		subject: parsed.subject || '',
		text: parsed.text || '',
		content: parsed.html || '',
		attachments,
	}, userId);

	return c.json(result.ok({ emailId: emailResult.emailId, status: emailResult.status }));
});
