/**
 * SMTP submission 服务(M2):监听 465(SMTPS),客户端发信通道
 * 流程:认证(委托 Worker)→ 收完整 MIME → 调 Worker send 接口 → CF Email Service/Resend 发出 → 回写 D1
 */
import net from 'node:net';
import tls from 'node:tls';
import client from './client.js';
import config from './config.js';

const MAX_MESSAGE_SIZE = 25 * 1024 * 1024; // 25MB

class SmtpSession {
	constructor(socket) {
		this.socket = socket;
		this.state = 'greeting';   // greeting | auth | mail | rcpt | data
		this.user = null;          // { userId, email, accounts }
		this.authPending = null;   // 等待 base64 凭据
		this.mailFrom = null;
		this.rcptTos = [];
		this.dataMode = false;     // DATA 收集模式(Buffer,附件无损)
		this.dataChunks = [];
		this.dataSize = 0;
		this.buffer = '';
		this._send('220 imap.example.com cloud-mail gateway ESMTP ready');
	}

	_send(line) {
		this.socket.write(line + '\r\n');
	}

	async handleLine(line) {
		// AUTH 交互模式
		if (this.authPending) {
			await this.resolveAuth(line);
			return;
		}

		if (!line.trim()) return;
		const space = line.indexOf(' ');
		const command = (space === -1 ? line : line.slice(0, space)).toUpperCase();
		const arg = space === -1 ? '' : line.slice(space + 1).trim();

		try {
			await this.dispatch(command, arg);
		} catch (e) {
			console.error('[smtp] 处理异常:', e);
			this._send('451 Requested action aborted: local error');
		}
	}

	async dispatch(command, arg) {
		switch (command) {
			case 'EHLO':
			case 'HELO': {
				this._send('250-imap.example.com');
				this._send('250-SIZE ' + MAX_MESSAGE_SIZE);
				this._send('250-8BITMIME');
				this._send('250-AUTH PLAIN LOGIN');
				this._send('250 HELP');
				this.state = 'auth';
				return;
			}
			case 'AUTH':
				return this.handleAuth(arg);
			case 'MAIL':
				if (!this.user) {
					this._send('530 5.7.0 Authentication required');
					return;
				}
				this.mailFrom = arg;
				this.rcptTos = [];
				this._send('250 2.1.0 Ok');
				this.state = 'mail';
				return;
			case 'RCPT':
				if (this.state !== 'mail' && this.state !== 'rcpt') {
					this._send('503 5.5.1 Bad sequence of commands');
					return;
				}
				this.rcptTos.push(arg);
				this.state = 'rcpt';
				this._send('250 2.1.5 Ok');
				return;
			case 'DATA':
				if (this.state !== 'rcpt' || this.rcptTos.length === 0) {
					this._send('503 5.5.1 Bad sequence of commands');
					return;
				}
				this._send('354 End data with <CR><LF>.<CR><LF>');
				this.dataMode = true;
				this.dataChunks = [];
				this.dataSize = 0;
				return;
			case 'RSET':
				this.mailFrom = null;
				this.rcptTos = [];
				this.dataMode = false;
				this.dataChunks = [];
				this.state = this.user ? 'auth' : 'greeting';
				this._send('250 2.0.0 Ok');
				return;
			case 'NOOP':
				this._send('250 2.0.0 Ok');
				return;
			case 'QUIT':
				this._send('221 2.0.0 Bye');
				this.socket.end();
				return;
			default:
				this._send('502 5.5.2 Error: command not recognized');
		}
	}

	async handleAuth(arg) {
		const mech = (arg.split(' ')[0] || '').toUpperCase();
		if (mech === 'PLAIN') {
			const rest = arg.slice(mech.length).trim();
			if (rest) {
				await this.doPlainAuth(rest);
			} else {
				this._send('334 ');
				this.authPending = { type: 'plain' };
			}
			return;
		}
		if (mech === 'LOGIN') {
			this._send('334 VXNlcm5hbWU6'); // Username:
			this.authPending = { type: 'login', step: 'user' };
			return;
		}
		this._send('504 5.5.4 Unrecognized authentication type');
	}

	async resolveAuth(line) {
		const pending = this.authPending;
		if (pending.type === 'plain') {
			try {
				const decoded = Buffer.from(line.trim(), 'base64').toString('utf-8');
				const [, email, password] = decoded.split('\0');
				await this.doLogin(email, password);
			} catch {
				this._send('535 5.7.8 Authentication credentials invalid');
			}
			this.authPending = null;
			return;
		}
		if (pending.type === 'login') {
			if (pending.step === 'user') {
				pending.user = Buffer.from(line.trim(), 'base64').toString('utf-8');
				pending.step = 'pass';
				this._send('334 UGFzc3dvcmQ6'); // Password:
				return;
			}
			try {
				const password = Buffer.from(line.trim(), 'base64').toString('utf-8');
				await this.doLogin(pending.user, password);
			} catch {
				this._send('535 5.7.8 Authentication credentials invalid');
			}
			this.authPending = null;
		}
	}

	async doPlainAuth(b64) {
		try {
			const decoded = Buffer.from(b64.trim(), 'base64').toString('utf-8');
			const [, email, password] = decoded.split('\0');
			await this.doLogin(email, password);
		} catch {
			this._send('535 5.7.8 Authentication credentials invalid');
		}
	}

	async doLogin(email, password) {
		if (!email || !password) {
			throw new Error('empty credentials');
		}
		const data = await client.auth(email, password);
		this.user = { userId: data.userId, email: data.email, accounts: data.accounts };
		this.state = 'auth';
		this._send('235 2.7.0 Authentication successful');
	}

	async finishData() {
		const mimeBuf = Buffer.concat(this.dataChunks);
		this.dataChunks = [];
		this.dataSize = 0;
		this.state = 'mail';
		if (mimeBuf.length === 0) {
			this._send('451 4.3.0 Empty message');
			return;
		}
		try {
			const data = await client.send(this.user.userId, mimeBuf);
			console.log(`[smtp] 已发送 ${this.user.email} → ${this.rcptTos.length} 收件人 (emailId=${data.emailId})`);
			this.mailFrom = null;
			this.rcptTos = [];
			this._send('250 2.0.0 Ok: queued');
		} catch (e) {
			console.error('[smtp] 发送失败:', e.message);
			this._send('451 4.3.0 Temporary failure: ' + e.message);
		}
	}
}

export function createSmtpServer() {
	const onConnection = socket => {
		socket.setNoDelay(true);
		const session = new SmtpSession(socket);
		let buffer = Buffer.alloc(0);
		const CRLF = Buffer.from('\r\n');
		socket.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (session.dataMode) {
				// DATA:按行切分(Buffer),行首 '.' 结束,行首 '..' 还原
				let nl;
				while ((nl = buffer.indexOf(CRLF)) !== -1) {
					const line = buffer.subarray(0, nl);
					buffer = buffer.subarray(nl + 2);
					if (line.length === 1 && line[0] === 0x2e) {
						session.dataMode = false;
						session.finishData();
						break;
					}
					if (line.length > 1 && line[0] === 0x2e && line[1] === 0x2e) {
						session.dataChunks.push(line.subarray(1));
					} else {
						session.dataChunks.push(line);
					}
					session.dataChunks.push(CRLF);
					session.dataSize += line.length + 2;
					if (session.dataSize > MAX_MESSAGE_SIZE) {
						session._send('552 Message size exceeds fixed limit');
						session.dataMode = false;
						session.dataChunks = [];
						session.dataSize = 0;
						break;
					}
				}
				return;
			}
			let nl;
			while ((nl = buffer.indexOf(CRLF)) !== -1) {
				const line = buffer.subarray(0, nl).toString('utf-8');
				buffer = buffer.subarray(nl + 2);
				session.handleLine(line);
			}
		});
		socket.on('error', e => {
			console.error('[smtp] 连接错误:', e.message);
		});
	};

	if (config.tlsCert && config.tlsKey) {
		return tls.createServer({ cert: config.tlsCert, key: config.tlsKey }, onConnection);
	}
	return net.createServer(onConnection);
}
