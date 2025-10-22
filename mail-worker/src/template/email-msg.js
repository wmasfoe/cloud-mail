export default function emailMsgTemplate(email) {
	return `<b>${email.subject}</b>

发件人：${email.name}		&lt;${email.sendEmail}&gt;
收件人：\u200B${email.toEmail}`

}
