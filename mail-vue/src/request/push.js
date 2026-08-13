import http from '@/axios/index.js'

/** VAPID 公钥(订阅用) */
export function pushVapidKey() {
    return http.get('/push/vapid-key');
}

/** 注册推送订阅 */
export function pushSubscribe(endpoint, p256dh, auth) {
    return http.post('/push/subscribe', {endpoint, p256dh, auth});
}

/** 注销推送订阅 */
export function pushUnsubscribe(endpoint) {
    return http.post('/push/unsubscribe', {endpoint});
}

/** 子邮箱推送开关 */
export function accountSetPushEnabled(accountId, pushEnabled) {
    return http.put('/account/setPushEnabled', {accountId, pushEnabled});
}
