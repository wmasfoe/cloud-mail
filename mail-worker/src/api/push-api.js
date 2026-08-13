import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import orm from '../entity/orm';
import pushSubscription from '../entity/push-subscription';
import account from '../entity/account';
import { eq, and } from 'drizzle-orm';

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

/** VAPID 公钥(公开,前端订阅用) */
app.get('/push/vapid-key', async (c) => {
	const privateJwk = JSON.parse(c.env.VAPID_PRIVATE_JWK || 'null');
	if (!privateJwk) {
		return c.json(result.fail('VAPID not configured', 500));
	}
	const publicKey = bufToB64url(new Uint8Array([4, ...b64urlToBuf(privateJwk.x), ...b64urlToBuf(privateJwk.y)]));
	return c.json(result.ok({ publicKey }));
});

/** 注册推送订阅(需登录;同 endpoint 覆盖更新) */
app.post('/push/subscribe', async (c) => {
	const userId = userContext.getUserId(c);
	const body = await c.req.json();
	const { endpoint, p256dh, auth } = body;
	if (!endpoint || !p256dh || !auth) {
		return c.json(result.fail('endpoint/p256dh/auth required', 400));
	}
	// 同 endpoint 先删再插(设备重装/订阅刷新)
	await orm(c).delete(pushSubscription)
		.where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)));
	await orm(c).insert(pushSubscription).values({ userId, endpoint, p256dh, auth });
	return c.json(result.ok());
});

/** 注销推送订阅(需登录) */
app.post('/push/unsubscribe', async (c) => {
	const userId = userContext.getUserId(c);
	const { endpoint } = await c.req.json();
	if (endpoint) {
		await orm(c).delete(pushSubscription)
			.where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)));
	}
	return c.json(result.ok());
});

/** 子邮箱推送开关(主账号管理名下邮箱) */
app.put('/account/setPushEnabled', async (c) => {
	const userId = userContext.getUserId(c);
	const { accountId, pushEnabled } = await c.req.json();
	await orm(c).update(account)
		.set({ pushEnabled: pushEnabled ? 1 : 0 })
		.where(and(eq(account.accountId, accountId), eq(account.userId, userId)));
	return c.json(result.ok());
});
