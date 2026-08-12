/**
 * IMAP 协议层(轻量子集,M1 只读 + STORE/EXPUNGE/伪 IDLE)
 * 无状态网关:所有邮件数据实时来自 Worker API,D1/R2 为唯一数据源
 */
import net from 'node:net';
import tls from 'node:tls';
import client from './client.js';
import config from './config.js';

const FOLDERS = {
	'INBOX': { type: 0, label: 'INBOX' },
	'Sent': { type: 1, label: 'Sent' },
};

const FLAG_SEEN = '\\Seen';
const FLAG_FLAGGED = '\\Flagged';
const FLAG_DELETED = '\\Deleted';

// ---------- 工具 ----------

function write(socket, text) {
	socket.write(text + '\r\n');
}

function untagged(socket, line) {
	socket.write('* ' + line + '\r\n');
}

/** 解析命令行参数(支持双引号字符串) */
function splitArgs(line) {
	const args = [];
	let i = 0;
	const len = line.length;
	while (i < len) {
		while (i < len && line[i] === ' ') i++;
		if (i >= len) break;
		if (line[i] === '"') {
			let j = i + 1;
			let buf = '';
			while (j < len) {
				if (line[j] === '\\' && j + 1 < len) {
					buf += line[j + 1];
					j += 2;
				} else if (line[j] === '"') {
					j++;
					break;
				} else {
					buf += line[j];
					j++;
				}
			}
			args.push(buf);
			i = j;
		} else {
			let j = i;
			while (j < len && line[j] !== ' ') j++;
			args.push(line.slice(i, j));
			i = j;
		}
	}
	return args;
}

/** 解析消息序号集合:"1:*" "1,3,5" "2" "1:*" */
function parseSequenceSet(text, total) {
	const result = [];
	const parts = text.split(',');
	for (const part of parts) {
		const m = part.match(/^(\d+|\*)(?::(\d+|\*))?$/);
		if (!m) return null;
		const start = m[1] === '*' ? total : Number(m[1]);
		const end = m[2] === undefined ? start : (m[2] === '*' ? total : Number(m[2]));
		if (start < 1 || end < start || start > total) continue;
		for (let n = start; n <= end; n++) result.push(n);
	}
	return result;
}

/** RFC2047 解码(=?utf-8?B?...?= / =?utf-8?Q?...?=) */
function decodeMimeWord(str) {
	if (!str) return '';
	return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, charset, enc, data) => {
		try {
			if (enc.toUpperCase() === 'B') {
				return Buffer.from(data, 'base64').toString('utf-8');
			}
			return data.replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
				.replace(/_/g, ' ');
		} catch {
			return all;
		}
	});
}

/** 把字符串转成 IMAP 引号字符串 */
function qstr(s) {
	return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 解析单个邮箱地址 "Name <a@b>" → 返回 ENVELOPE 地址数组片段 */
function parseAddressList(value) {
	if (!value) return 'NIL';
	// 简单切分(忽略引号内的逗号)
	const addrs = [];
	let current = '';
	let inQuote = false;
	for (const ch of value) {
		if (ch === '"') inQuote = !inQuote;
		if (ch === ',' && !inQuote) {
			addrs.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) addrs.push(current.trim());

	const parts = addrs.map(raw => {
		const m = raw.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
		let name = '';
		let addr = '';
		if (m) {
			name = decodeMimeWord(m[1].trim());
			addr = m[2];
		} else {
			addr = raw;
		}
		const at = addr.lastIndexOf('@');
		const mailbox = at === -1 ? addr : addr.slice(0, at);
		const host = at === -1 ? '' : addr.slice(at + 1);
		return `(${qstr(name)} NIL ${qstr(mailbox)} ${qstr(host)})`;
	});
	return parts.length ? '(' + parts.join(' ') + ')' : 'NIL';
}

/** MIME 头解析 → { headers: Map(小写名→值), head: 头文本, body: 正文(Buffer 时保留字节) } */
function splitMime(mime) {
	const isBuf = Buffer.isBuffer(mime);
	const sep = Buffer.from('\r\n\r\n');
	let idx, head, body;
	if (isBuf) {
		idx = mime.indexOf(sep);
		head = (idx === -1 ? mime : mime.subarray(0, idx)).toString('utf-8');
		body = idx === -1 ? Buffer.alloc(0) : mime.subarray(idx + 4);
	} else {
		idx = mime.indexOf('\r\n\r\n');
		head = idx === -1 ? mime : mime.slice(0, idx);
		body = idx === -1 ? '' : mime.slice(idx + 4);
	}
	const headers = new Map();
	for (const line of head.split('\r\n')) {
		if (/^[\t ]/.test(line)) {
			// 折叠头,附加到上一条
			const last = [...headers.entries()].pop();
			if (last) headers.set(last[0], last[1] + ' ' + line.trim());
			continue;
		}
		const ci = line.indexOf(':');
		if (ci === -1) continue;
		const name = line.slice(0, ci).trim().toLowerCase();
		const value = line.slice(ci + 1).trim();
		headers.set(name, headers.has(name) ? headers.get(name) + ', ' + value : value);
	}
	return { headers, head, body };
}

/** INTERNALDATE:"12-Aug-2026 15:43:22 +0000" */
function formatInternalDate(createTime) {
	let date;
	if (!createTime) {
		date = new Date();
	} else {
		const normalized = createTime.includes('T') ? createTime : createTime.replace(' ', 'T') + 'Z';
		date = new Date(normalized);
	}
	if (isNaN(date.getTime())) date = new Date();
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const pad = n => String(n).padStart(2, '0');
	const offMin = -date.getTimezoneOffset();
	const sign = offMin >= 0 ? '+' : '-';
	const abs = Math.abs(offMin);
	return `${pad(date.getDate())}-${months[date.getMonth()]}-${date.getFullYear()} `
		+ `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
		+ `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

// ---------- 会话 ----------

class ImapSession {
	constructor(socket) {
		this.socket = socket;
		this.state = 'not-authenticated'; // not-authenticated | authenticated | selected
		this.user = null;      // { userId, email, accounts }
		this.mailbox = null;   // { name, type, label }
		this.messages = [];    // [{ emailId, unread, starred, deleted, mime, createTime }]
		this.uidvalidity = 0;
		this.uidnext = 1;
		this.lastPolledId = 0; // IDLE 轮询水位线
		this.idleTimer = null;
		this.idleState = false;
		this.buffer = '';
		this.appendState = null; // { tag, mailbox, size, received, chunks }
	}

	send(line) { write(this.socket, line); }
	untagged(line) { untagged(this.socket, line); }

	tagged(tag, status, text = '') {
		this.send(`${tag} ${status}${text ? ' ' + text : ''}`);
	}

	async handleLine(line) {
		if (process.env.IMAP_DEBUG) {
			const dbg = line.length > 120 ? line.slice(0, 120) + '...' : line;
			console.log(`[imap] < ${dbg}`);
		}
		if (this.idleState) {
			if (line.trim().toUpperCase() === 'DONE') {
				clearInterval(this.idleTimer);
				this.idleTimer = null;
				this.idleState = false;
				this.tagged(this.idleTag, 'OK', 'IDLE terminated');
			} else {
				this.send('BAD Unknown command during IDLE');
			}
			return;
		}

		if (!line.trim()) return;

		const parts = splitArgs(line);
		const tag = parts[0];
		const command = (parts[1] || '').toUpperCase();
		const args = parts.slice(2);

		if (command === 'APPEND') {
			return this.cmdAppendStart(tag, args);
		}

		try {
			await this.dispatch(tag, command, args);
		} catch (e) {
			console.error(`[imap] ${command} 处理异常:`, e);
			this.tagged(tag, 'NO', e.message || 'Internal error');
		}
	}

	async dispatch(tag, command, args) {
		switch (command) {
			case 'CAPABILITY':
				this.untagged('CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE');
				this.tagged(tag, 'OK', 'CAPABILITY completed');
				return;
			case 'NOOP':
				this.tagged(tag, 'OK', 'NOOP completed');
				return;
			case 'LOGOUT':
				this.untagged('BYE Logging out');
				this.tagged(tag, 'OK', 'LOGOUT completed');
				this.socket.end();
				return;
			case 'LOGIN':
				return this.cmdLogin(tag, args);
			case 'AUTHENTICATE':
				return this.cmdAuthenticate(tag, args);
			default:
				break;
		}

		if (this.state === 'not-authenticated') {
			this.tagged(tag, 'NO', 'Please authenticate first');
			return;
		}

		switch (command) {
			case 'LIST':
			case 'LSUB':
				this.untagged('LIST (\\HasNoChildren) "/" INBOX');
				this.untagged('LIST (\\HasNoChildren) "/" Sent');
				this.tagged(tag, 'OK', `${command} completed`);
				return;
			case 'SELECT':
			case 'EXAMINE':
				return this.cmdSelect(tag, command, args);
			case 'STATUS':
				return this.cmdStatus(tag, args);
			case 'CLOSE':
				this.state = 'authenticated';
				this.mailbox = null;
				this.messages = [];
				this.tagged(tag, 'OK', 'CLOSE completed');
				return;
			case 'FETCH':
				return this.cmdFetchOrUid(tag, command, args);
			case 'UID':
				// UID SEARCH / UID FETCH 分流
				if (args[0] && args[0].toUpperCase() === 'SEARCH') {
					return this.cmdSearch(tag, args.slice(1), true);
				}
				return this.cmdFetchOrUid(tag, command, args);
			case 'STORE':
				return this.cmdStore(tag, args, false);
			case 'EXPUNGE':
				return this.cmdExpunge(tag, args, false);
			case 'SEARCH':
				return this.cmdSearch(tag, args);
			case 'IDLE':
				return this.cmdIdle(tag);
			case 'CHECK':
				this.tagged(tag, 'OK', 'CHECK completed');
				return;
			case 'APPEND':
				return this.cmdAppendStart(tag, args);
			default:
				this.tagged(tag, 'BAD', `${command} not implemented (M1 subset)`);
		}
	}

	/** APPEND:解析 literal 大小,进入收集状态 */
	async cmdAppendStart(tag, args) {
		if (this.state === 'not-authenticated') {
			this.tagged(tag, 'NO', 'Please authenticate first');
			return;
		}
		const mailbox = args[0];
		if (!FOLDERS[mailbox]) {
			this.tagged(tag, 'NO', 'Mailbox does not exist');
			return;
		}
		const sizeArg = args[args.length - 1];
		const m = /^\{(\d+)\}$/.exec(sizeArg || '');
		if (!m) {
			this.tagged(tag, 'BAD', 'APPEND requires literal size');
			return;
		}
		const size = Number(m[1]);
		if (size > 25 * 1024 * 1024) {
			this.tagged(tag, 'NO', 'Message too large');
			return;
		}
		this.appendState = { tag, mailbox, size, received: 0, chunks: [] };
		this.send('+ Ready for literal data');
	}

	/** literal 收满后:提交 Worker 存 D1(Message-ID 去重) */
	async finishAppend() {
		const st = this.appendState;
		this.appendState = null;
		try {
			const mimeBuf = Buffer.concat(st.chunks);
			const data = await client.append(this.user.userId, st.mailbox, mimeBuf);
			this.tagged(st.tag, 'OK', 'APPEND completed' + (data.duplicate ? ' (duplicate skipped)' : ''));
		} catch (e) {
			console.error('[imap] APPEND 失败:', e.message);
			this.tagged(st.tag, 'NO', e.message || 'APPEND failed');
		}
	}

	async cmdLogin(tag, args) {
		if (args.length < 2) {
			this.tagged(tag, 'BAD', 'LOGIN requires email and password');
			return;
		}
		try {
			const data = await client.auth(args[0], args[1]);
			this.user = data;
			this.state = 'authenticated';
			this.tagged(tag, 'OK', 'LOGIN completed');
		} catch (e) {
			this.tagged(tag, 'NO', 'Authentication failed');
		}
	}

	async cmdAuthenticate(tag, args) {
		const mech = (args[0] || '').toUpperCase();
		if (mech !== 'PLAIN') {
			this.tagged(tag, 'NO', 'Unsupported authentication mechanism');
			return;
		}
		this.send('+');
		// 下一条消息是 base64(\0user\0pass),由 handleLine 的后续调用处理
		this.pendingAuth = true;
		this.pendingAuthTag = tag;
	}

	async resolveAuthLine(line) {
		if (!this.pendingAuth) return false;
		const tag = this.pendingAuthTag;
		this.pendingAuth = false;
		try {
			const decoded = Buffer.from(line.trim(), 'base64').toString('utf-8');
			const [ , email, password ] = decoded.split('\0');
			const data = await client.auth(email, password);
			this.user = data;
			this.state = 'authenticated';
			this.tagged(tag, 'OK', 'AUTHENTICATE completed');
		} catch (e) {
			this.tagged(tag, 'NO', 'Authentication failed');
		}
		return true;
	}

	async cmdSelect(tag, command, args) {
		const folderName = args[0];
		const folder = FOLDERS[folderName];
		if (!folder) {
			this.tagged(tag, 'NO', `Mailbox ${folderName} does not exist`);
			return;
		}

		await this.loadMailbox(folder);

		this.untagged('FLAGS (\\Seen \\Flagged \\Deleted)');
		this.untagged('OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] Limited');
		this.untagged(`${this.messages.length} EXISTS`);
		this.untagged('0 RECENT');
		this.untagged(`OK [UIDVALIDITY ${this.uidvalidity}] UIDs valid`);
		this.untagged(`OK [UIDNEXT ${this.uidnext}] Predicted next UID`);
		const unreadCount = this.messages.filter(m => !m.unread).length;
		if (unreadCount > 0) {
			this.untagged(`OK [UNSEEN ${this.messages.findIndex(m => !m.unread) + 1}] First unseen`);
		}
		this.state = 'selected';
		this.tagged(tag, 'OK', `[${command === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] ${command} completed`);
	}

	async loadMailbox(folder) {
		const userId = this.user.userId;
		const mbox = await client.mailboxes(userId);
		this.uidvalidity = mbox.uidvalidity;

		const messages = [];
		let since = 0;
		while (true) {
			const page = await client.emails(userId, folder.label.toLowerCase(), since, config.pageSize);
			messages.push(...page.list);
			since = page.latestEmailId;
			if (page.list.length < config.pageSize) break;
		}
		this.messages = messages.map(m => ({
			emailId: m.emailId,
			unread: m.unread === 1,
			starred: !!m.starred,
			deleted: false,
			createTime: m.createTime,
			mime: null,
		}));
		this.mailbox = folder;
		this.lastPolledId = since;
		this.uidnext = since + 1;
	}

	async cmdStatus(tag, args) {
		const folderName = args[0];
		if (!FOLDERS[folderName]) {
			this.tagged(tag, 'NO', 'Mailbox does not exist');
			return;
		}
		await this.loadMailbox(FOLDERS[folderName]);
		const unread = this.messages.filter(m => !m.unread).length;
		this.untagged(`STATUS ${folderName} (MESSAGES ${this.messages.length} UNSEEN ${unread} UIDNEXT ${this.uidnext} UIDVALIDITY ${this.uidvalidity})`);
		this.tagged(tag, 'OK', 'STATUS completed');
	}

	async getMime(msg) {
		if (!msg.mime) {
			const data = await client.email(this.user.userId, msg.emailId);
			msg.mime = data.mime; // Buffer(Worker 端 base64 解码,附件字节无损)
		}
		return msg.mime;
	}

	buildFlags(msg) {
		const flags = [];
		if (msg.unread) flags.push(FLAG_SEEN);
		if (msg.starred) flags.push(FLAG_FLAGGED);
		if (msg.deleted) flags.push(FLAG_DELETED);
		return flags.length ? `(${flags.join(' ')})` : '()';
	}

	async fetchMessage(msg, seq, items) {
		// 返回混合数组:[{ t: '文本' }, { b: Buffer }];literal 内容用 Buffer 保证二进制无损
		const parts = [{ t: `* ${seq} FETCH (` }];
		for (const item of items) {
			const upper = item.toUpperCase();
			if (upper === 'UID') {
				parts.push({ t: `UID ${msg.emailId}` });
			} else if (upper === 'FLAGS') {
				parts.push({ t: `FLAGS ${this.buildFlags(msg)}` });
			} else if (upper === 'INTERNALDATE') {
				parts.push({ t: `INTERNALDATE ${qstr(formatInternalDate(msg.createTime))}` });
			} else if (upper === 'RFC822.SIZE') {
				const mime = await this.getMime(msg);
				parts.push({ t: `RFC822.SIZE ${mime.length}` });
			} else if (upper === 'RFC822.HEADER' || upper === 'BODY.PEEK[HEADER]' || upper === 'BODY[HEADER]') {
				const mime = await this.getMime(msg);
				const { head } = splitMime(mime);
				parts.push({ t: `${item.includes('HEADER') && item.startsWith('BODY') ? 'BODY[HEADER]' : 'RFC822.HEADER'} {${Buffer.byteLength(head, 'utf-8')}}\r\n` });
				parts.push({ t: head });
				parts.push({ t: ' ' });
				if (upper === 'BODY[HEADER]') msg.unread = true;
			} else if (upper === 'BODY.PEEK[TEXT]' || upper === 'BODY[TEXT]') {
				const mime = await this.getMime(msg);
				const { body } = splitMime(mime);
				const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
				parts.push({ t: `BODY[TEXT] {${bodyBuf.length}}\r\n` });
				parts.push({ b: bodyBuf });
				parts.push({ t: ' ' });
				if (upper === 'BODY[TEXT]') msg.unread = true;
			} else if (upper === 'BODY[]' || upper === 'BODY.PEEK[]' || upper === 'RFC822.ALL' || upper === 'RFC822') {
				const mime = await this.getMime(msg);
				const name = upper === 'RFC822.ALL' || upper === 'RFC822' ? 'RFC822.ALL' : 'BODY[]';
				parts.push({ t: `${name} {${mime.length}}\r\n` });
				parts.push({ b: mime });
				parts.push({ t: ' ' });
				if (upper === 'BODY[]') msg.unread = true;
			} else if (upper === 'ENVELOPE') {
				parts.push({ t: `ENVELOPE ${await this.buildEnvelope(msg)}` });
			} else if (upper === 'BODYSTRUCTURE') {
				const mime = await this.getMime(msg);
				parts.push({ t: `BODYSTRUCTURE ${buildBasicStructure(mime)}` });
			} else if (upper.startsWith('BODY.PEEK[')) {
				// 其他 body section:取全文(简化)
				const mime = await this.getMime(msg);
				parts.push({ t: `BODY[${item.slice(10, -1)}] {${mime.length}}\r\n` });
				parts.push({ b: mime });
				parts.push({ t: ' ' });
			} else {
				// 未知 item,返回空
				parts.push({ t: `${item} NIL` });
			}
			parts.push({ t: ' ' });
		}
		parts.push({ t: ')' });
		return parts;
	}

	async buildEnvelope(msg) {
		const mime = await this.getMime(msg);
		const { headers } = splitMime(mime);
		const get = name => headers.get(name) || '';

		const date = get('date');
		const subject = decodeMimeWord(get('subject'));
		const from = parseAddressList(get('from'));
		const to = parseAddressList(get('to'));
		const cc = parseAddressList(get('cc'));
		const bcc = parseAddressList(get('bcc'));
		const replyTo = parseAddressList(get('reply-to') || get('from'));
		const inReplyTo = get('in-reply-to');
		const messageId = get('message-id');

		return `(${qstr(date)} ${qstr(subject)} ${from} ${from} ${replyTo} ${to} ${cc} ${bcc} ${qstr(inReplyTo)} ${qstr(messageId)})`;
	}

	async cmdFetchOrUid(tag, command, args) {
		if (this.state !== 'selected') {
			this.tagged(tag, 'NO', 'No mailbox selected');
			return;
		}
		const isUid = command === 'UID';
		const rest = isUid ? args.slice(1) : args;
		const setText = rest[0];
		const itemText = rest.slice(1).join(' ').trim();

		const seqs = parseSequenceSet(setText, this.messages.length);
		if (!seqs) {
			this.tagged(tag, 'BAD', 'Invalid sequence set');
			return;
		}

		const items = parseFetchItems(itemText);
		if (!items) {
			this.tagged(tag, 'BAD', 'Invalid fetch items');
			return;
		}

		const target = [];
		for (const seq of seqs) {
			const msg = this.messages[seq - 1];
			if (!msg) continue;
			if (isUid) {
				const uidRange = setText.split(',');
				// UID FETCH 的 set 是 UID 集合,需要重新解析
				target.push({ seq, msg });
			} else {
				target.push({ seq, msg });
			}
		}

		if (isUid) {
			// 按 UID 过滤:重新解析 UID 集合
			const uids = parseSequenceSet(setText, this.uidnext - 1);
			target.length = 0;
			if (uids) {
				for (const uid of uids) {
					const idx = this.messages.findIndex(m => m.emailId === uid);
					if (idx !== -1) target.push({ seq: idx + 1, msg: this.messages[idx] });
				}
			}
		}

		for (const { seq, msg } of target) {
			const parts = await this.fetchMessage(msg, seq, items);
			// 文本累积成一行,literal(Buffer)插入,行尾统一 \r\n
			let out = '';
			for (const p of parts) {
				if (p.b) {
					this.socket.write(out);
					out = '';
					this.socket.write(p.b);
				} else {
					out += p.t;
				}
			}
			this.socket.write(out + '\r\n');
		}
		this.tagged(tag, 'OK', 'FETCH completed');
	}

	async cmdStore(tag, args, isUid) {
		if (this.state !== 'selected') {
			this.tagged(tag, 'NO', 'No mailbox selected');
			return;
		}
		const setText = args[0];
		const modeText = (args[1] || '').toUpperCase();
		const flagText = args.slice(2).join(' ').replace(/^\(|\)$/g, '');

		const m = modeText.match(/^([+-])?FLAGS(\.SILENT)?$/);
		if (!m) {
			this.tagged(tag, 'BAD', 'Invalid STORE syntax');
			return;
		}
		const add = m[1] === '+';
		const remove = m[1] === '-';
		const silent = !!m[2];
		const flags = flagText.split(/\s+/).filter(Boolean);

		const seqs = parseSequenceSet(setText, this.messages.length);
		if (!seqs) {
			this.tagged(tag, 'BAD', 'Invalid sequence set');
			return;
		}

		for (const seq of seqs) {
			const msg = this.messages[seq - 1];
			if (!msg) continue;
			for (const flag of flags) {
				const on = flag.toUpperCase();
				if (on === FLAG_SEEN) msg.unread = !(add || (remove ? msg.unread : false));
				else if (on === FLAG_FLAGGED) msg.starred = add ? true : (remove ? false : true);
				else if (on === FLAG_DELETED) msg.deleted = add ? true : (remove ? false : true);
			}
			// 写入 D1(单一数据源)
			try {
				await client.flags(this.user.userId, msg.emailId, {
					seen: msg.unread,
					starred: msg.starred,
					deleted: msg.deleted,
				});
			} catch (e) {
				console.error('[imap] flags 写入失败:', e);
			}
			if (!silent) {
				this.send(`* ${seq} FETCH (FLAGS ${this.buildFlags(msg)})`);
			}
		}
		this.tagged(tag, 'OK', 'STORE completed');
	}

	async cmdExpunge(tag, args, isUid) {
		if (this.state !== 'selected') {
			this.tagged(tag, 'NO', 'No mailbox selected');
			return;
		}
		const removed = [];
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i].deleted) {
				this.send(`* ${i + 1} EXPUNGE`);
				removed.push(i);
			}
		}
		for (const idx of removed.sort((a, b) => a - b)) {
			this.messages.splice(idx, 1);
		}
		this.tagged(tag, 'OK', 'EXPUNGE completed');
	}

	/** SEARCH:支持 ALL/UNSEEN/RECENT/SINCE <date>;UID SEARCH 返回 UID(emailId) */
	async cmdSearch(tag, args, isUid = false) {
		if (this.state !== 'selected') {
			this.tagged(tag, 'NO', 'No mailbox selected');
			return;
		}
		const raw = args.map(a => a.replace(/^\(|\)$/g, ''));
		const criteria = raw.map(a => a.toUpperCase());
		const seqOf = (m, i) => (isUid ? m.emailId : i + 1);
		let result = [];
		if (criteria.includes('ALL') || criteria.length === 0) {
			result = this.messages.map((m, i) => seqOf(m, i));
		} else if (criteria.includes('UNSEEN')) {
			result = this.messages.map((m, i) => (!m.unread ? seqOf(m, i) : 0)).filter(Boolean);
		} else if (criteria.includes('RECENT')) {
			result = [];
		} else if (criteria.includes('SINCE')) {
			const sinceIdx = criteria.indexOf('SINCE');
			const dateText = raw[sinceIdx + 1];
			if (dateText) {
				// IMAP 日期格式:13-Jul-2026 → Date(UTC 当日 0 点)
				const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(dateText);
				if (m) {
					const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
					const since = Date.UTC(Number(m[3]), months[m[2].toUpperCase()], Number(m[1]));
					result = this.messages.map((m2, i) => {
						const t = Date.parse(m2.createTime.replace(' ', 'T') + 'Z');
						return !isNaN(t) && t >= since ? seqOf(m2, i) : 0;
					}).filter(Boolean);
				}
			}
		}
		this.untagged(`SEARCH ${result.join(' ')}`.trim());
		this.tagged(tag, 'OK', 'SEARCH completed');
	}

	async cmdIdle(tag) {
		if (this.state !== 'selected') {
			this.tagged(tag, 'NO', 'No mailbox selected');
			return;
		}
		this.send('+ idling');
		this.idleState = true;
		this.idleTag = tag;
		this.idleTimer = setInterval(() => this.pollNewMail(), config.idlePollMs);
	}

	async pollNewMail() {
		try {
			const page = await client.emails(this.user.userId, this.mailbox.label.toLowerCase(), this.lastPolledId, config.pageSize);
			if (page.list.length > 0) {
				for (const m of page.list) {
					this.messages.push({
						emailId: m.emailId,
						unread: m.unread === 1,
						starred: !!m.starred,
						deleted: false,
						createTime: m.createTime,
						mime: null,
					});
				}
				this.lastPolledId = page.latestEmailId;
				this.uidnext = page.latestEmailId + 1;
				this.send(`* ${this.messages.length} EXISTS`);
			}
		} catch (e) {
			console.error('[imap] IDLE 轮询失败:', e);
		}
	}

	destroy() {
		if (this.idleTimer) {
			clearInterval(this.idleTimer);
			this.idleTimer = null;
		}
	}
}

// ---------- FETCH items 解析 ----------

function parseFetchItems(text) {
	let content = text.trim();
	if (content.startsWith('(') && content.endsWith(')')) {
		content = content.slice(1, -1);
	}
	if (!content) return ['BODY[]'];
	// 按空格切分,但保留 BODY[HEADER.FIELDS (X Y)] 这类括号
	const items = [];
	let current = '';
	let depth = 0;
	for (const ch of content) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ' ' && depth === 0) {
			if (current) items.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	if (current) items.push(current);
	// 展开 BODY[HEADER.FIELDS (...)] 中的子括号为单 item(简化:整体保留)
	return items.length ? items : ['BODY[]'];
}

// ---------- BODYSTRUCTURE 简化 ----------

function buildBasicStructure(mime) {
	const { headers } = splitMime(mime);
	const contentType = headers.get('content-type') || 'text/plain';
	const m = contentType.match(/^([^/;]+)\/([^;]+)/i);
	const type = (m ? m[1] : 'text').toLowerCase();
	const subtype = (m ? m[2] : 'plain').toLowerCase();
	const size = Buffer.byteLength(mime, 'utf-8');

	if (type === 'multipart') {
		// 简化:返回单部分结构,避免 iOS 解析失败
		return `("text" "plain" ("charset" "utf-8") NIL NIL NIL NIL 7bit ${size} 1)`;
	}

	const lines = mime.split('\r\n').length;
	const params = /charset="?([^";]+)"?/i.exec(contentType);
	const paramStr = params ? `("charset" ${qstr(params[1])})` : '("charset" "utf-8")';
	return `(${qstr(type)} ${qstr(subtype)} ${paramStr} NIL NIL NIL NIL 7bit ${size} ${lines})`;
}

// ---------- 服务器 ----------

export function createServer(handler) {
	const onConnection = socket => {
		socket.setNoDelay(true);
		const session = new ImapSession(socket);
		untagged(socket, 'OK [CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE] cloud-mail gateway ready');

		let buffer = '';
		const processLines = () => {
			let nl;
			while ((nl = buffer.indexOf('\r\n')) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 2);
				if (session.pendingAuth) {
					session.resolveAuthLine(line);
				} else {
					session.handleLine(line);
				}
			}
		};
		socket.on('data', chunk => {
			// APPEND literal:按字节收集(Buffer),不经过 UTF-8 字符串转换,附件无损
			const st = session.appendState;
			if (st) {
				const need = st.size - st.received;
				if (chunk.length >= need) {
					st.chunks.push(chunk.subarray(0, need));
					st.received += need;
					const rest = chunk.subarray(need);
					session.finishAppend().then(() => {
						if (rest.length) {
							buffer += rest.toString('utf-8');
							processLines();
						}
					});
				} else {
					st.chunks.push(chunk);
					st.received += chunk.length;
				}
				return;
			}
			buffer += chunk.toString('utf-8');
			processLines();
		});
		socket.on('error', e => {
			console.error('[imap] 连接错误:', e.message);
		});
		socket.on('close', () => session.destroy());
		if (handler) handler(socket, session);
	};

	if (config.tlsCert && config.tlsKey) {
		return tls.createServer({ cert: config.tlsCert, key: config.tlsKey }, onConnection);
	}
	return net.createServer(onConnection);
}
