import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';

export async function email(message, env, ctx) {

	try {

		if (!await settingService.isReceive({ env })) {
			return;
		}

		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		const params = {
			sendEmail: email.from.address,
			name: email.from.name,
			receiveEmail: message.to,
			subject: email.subject,
			content: email.html,
			text: email.text,
			userId: account.userId,
			accountId: account.accountId
		};

		const attachments = [];
		const cidAttachments = [];

		for(let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment)
			}
		}

		const emailRow = await emailService.receive({ env }, params, cidAttachments);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		})

		await attService.addAtt({ env }, attachments);

	} catch (e) {
		console.error('邮件接收异常: ', e);
	}
}
