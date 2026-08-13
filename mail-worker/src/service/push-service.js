/**
 * PWA Web Push 发送模块(Cloudflare Workers 原生,零依赖)
 * - VAPID JWT(ES256)签名:标识发送方(Worker)
 * - RFC 8291 消息加密:用订阅者公钥(p256dh)+ auth 加密 payload
 * - POST 到订阅 endpoint(APNs/其他推送服务)
 * 配置 env:VAPID_PRIVATE_JWK(JSON JWK 私钥,含 x/y/d)、VAPID_SUBJECT(mailto:)
 */

const enc = obj => btoa(JSON.stringify(obj)).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');

import { orm } from '../entity/orm';
import account from '../entity/account';
import pushSubscription from '../entity/push-subscription';
import { eq } from 'drizzle-orm';

function b64urlToBuf(b64url) {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
	const bin = atob(b64);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf;
}

function bufToB64url(buf) {
	let bin = '';
	for (const b of buf) bin += String.fromCharCode(b);
	return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 生成 VAPID JWT(ES256) */
async function signVapidJwt(privateJwk, subject, audience) {
	const header = { alg: 'ES256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const payload = { aud: audience, exp: now + 12 * 3600, sub: subject };
	const signingInput = enc(header) + '.' + enc(payload);
	const key = await crypto.subtle.importKey(
		'jwk',
		{ kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
	const sig = new Uint8Array(await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(signingInput)
	));
	return signingInput + '.' + bufToB64url(sig);
}

/** HKDF 提取+扩展 */
async function hkdf(ikm, salt, info, length) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info },
		key,
		length * 8
	);
	return new Uint8Array(bits);
}

/**
 * RFC 8291 加密 payload(aes128gcm)
 * 返回 { body: Uint8Array(完整 aes128gcm 消息), salt, serverPublicKey }
 */
async function encryptPayload(clientPublicKeyB64, authB64, payloadBuf) {
	const clientPublicKey = b64urlToBuf(clientPublicKeyB64);
	const authSecret = b64urlToBuf(authB64);

	// 服务器 ephemeral ECDH 密钥对
	const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey)); // 65 字节 04||x||y
	const clientKey = await crypto.subtle.importKey(
		'raw', clientPublicKey,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false, []
	);
	const shared = new Uint8Array(await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: clientKey },
		serverKeys.privateKey,
		256
	));

	// PRK = HKDF-Extract(auth, shared)
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const prk = await hkdf(shared, authSecret, new Uint8Array(0), 32);
	// 每个字节位翻转(PRK 按 RFC 8291 需要"xoring 0xFF")
	const prkXor = prk.map(b => b ^ 0xff);

	const keyInfo = new TextEncoder().encode('WebPush: info\x00' + bufToB64url(serverPub) + '\x00' + bufToB64url(clientPublicKey));
	const cek = await hkdf(prkXor, salt, keyInfo, 16);
	const nonce = await hkdf(prkXor, salt, keyInfo, 12);

	// AES-128-GCM 加密
	const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
	const cipher = new Uint8Array(await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, tagLength: 128 },
		aesKey,
		payloadBuf
	));

	// 组装 aes128gcm 消息: header(2+1+4+4+1+65) + ciphertext
	const body = new Uint8Array(87 + cipher.length);
	body[0] = 0; body[1] = 16;                        // salt 长度 16
	body.set(salt, 2);                                // salt
	body[18] = 0;                                     // rs = 4096 高位(4 字节)
	body[19] = 16; body[20] = 0; body[21] = 0;        // rs = 4096
	body[22] = cipher.length + 16;                    // idlen(4 字节)
	body[23] = 0; body[24] = 0; body[25] = 0;
	body[26] = 65;                                    // 服务器公钥长度
	body.set(serverPub, 27);                          // 服务器公钥(65 字节)
	body.set(cipher, 92);                             // 密文(92 = 27+65)

	return { body, serverPublicKey: bufToB64url(serverPub), salt: bufToB64url(salt) };
}

/**
 * 发送一条 Web Push
 * @param {object} sub { endpoint, keys: { p256dh, auth } }
 * @param {string|Uint8Array} payload 明文(可选;SW 端解析)
 * @returns {Promise<{ok:boolean, status:number, body:string}>}
 */
export async function sendWebPush(sub, payload = '', env = {}) {
	const privateJwk = JSON.parse((env.VAPID_PRIVATE_JWK || 'null'));
	const subject = env.VAPID_SUBJECT || 'mailto:admin@example.com';
	if (!privateJwk) {
		return { ok: false, status: 0, body: 'VAPID_PRIVATE_JWK not configured' };
	}
	const audience = new URL(sub.endpoint).origin;

	const jwt = await signVapidJwt(privateJwk, subject, audience);
	const publicKeyB64 = bufToB64url(new Uint8Array([
		4,
		...b64urlToBuf(privateJwk.x),
		...b64urlToBuf(privateJwk.y),
	]));

	let body;
	let headers = {};
	if (payload) {
		const { body: encrypted } = await encryptPayload(sub.keys.p256dh, sub.keys.auth, new TextEncoder().encode(payload));
		body = encrypted;
		headers = {
			'Content-Type': 'application/octet-stream',
			'Content-Encoding': 'aes128gcm',
			'TTL': '86400',
			'Urgency': 'high',
		};
	} else {
		body = new Uint8Array(0);
		headers = { 'Content-Length': '0', 'TTL': '86400', 'Urgency': 'high' };
	}

	const resp = await fetch(sub.endpoint, {
		method: 'POST',
		headers: {
			...headers,
			'Authorization': `vapid t=${jwt}, k=${publicKeyB64}`,
		},
		body,
	});
	return { ok: resp.ok, status: resp.status, body: await resp.text() };
}

/**
 * 收信后推送通知(子邮箱 push_enabled 开关控制,默认开)
 * @param {object} env Worker env
 * @param {object} emailRow email 表行(含 userId/accountId)
 * @param {object} email PostalMime 解析结果(含 from/subject)
 */
export async function pushNotify(env, emailRow, email) {
	// 1. 子邮箱推送开关
	const acc = await orm(env).select({ pushEnabled: account.pushEnabled }).from(account)
		.where(eq(account.accountId, emailRow.accountId))
		.get();
	if (!acc || !acc.pushEnabled) {
		return;
	}
	// 2. 该用户的设备订阅
	const subs = await orm(env).select().from(pushSubscription)
		.where(eq(pushSubscription.userId, emailRow.userId))
		.all();
	if (!subs.length) {
		return;
	}
	// 3. 逐个推送(payload 由 SW 解析显示)
	const fromName = email.from?.name || '';
	const title = fromName ? `${fromName} <${email.from.address}>` : (email.from?.address || '新邮件');
	const payload = JSON.stringify({ title, body: email.subject || '(无主题)' });
	for (const sub of subs) {
		try {
			const r = await sendWebPush(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
				payload,
				env
			);
			if (!r.ok && r.status !== 404 && r.status !== 410) {
				console.error(`[push] 发送失败 status=${r.status}: ${r.body}`);
			}
		} catch (e) {
			console.error('[push] 异常:', e.message);
		}
	}
}
