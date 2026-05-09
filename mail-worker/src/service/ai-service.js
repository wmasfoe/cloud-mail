import emailUtils from '../utils/email-utils';

const aiService = {
	async extractCode(c, email) {
		const ai = c.env.AI || c.env.ai;

		if (!ai) {
			return '';
		}

		try {
			const subject = email.subject || '';
			const text = emailUtils.formatText(email.text || '');
			const htmlText = emailUtils.htmlToText(email.html || '');
			const body = (htmlText || text).slice(0, 6000);

			if (!subject && !body) {
				return '';
			}

			const result = await ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct', {
				messages: [
					{
						role: 'system',
						content: 'You extract verification codes from emails. Return only JSON like {"code":"123456"} or {"code":""}. Do not explain.'
					},
					{
						role: 'user',
						content: `Subject: ${subject}\n\n${body}`
					}
				],
				temperature: 0,
				max_tokens: 32
			});

			const content = typeof result === 'string' ? result : result?.response || '';
			const json = JSON.parse(content);
			return typeof json.code === 'string' ? json.code.trim().slice(0, 64) : '';
		} catch (e) {
			console.error('验证码提取失败: ', e);
			return '';
		}
	}
};

export default aiService;
