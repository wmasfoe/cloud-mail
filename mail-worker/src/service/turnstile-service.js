import BizError from '../error/biz-error';

const turnstileService = {

	async verify(c, token) {

		if (!token) {
			throw new BizError('验证token不能为空');
		}
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				secret: c.env.secret_key,
				response: token,
				remoteip: c.req.header('cf-connecting-ip')
			})
		});

		const result = await res.json();

		if (!result.success) {
			throw new BizError('人机验证失败,请重试',400)
		}
	}
};

export default turnstileService;
