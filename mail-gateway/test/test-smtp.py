#!/usr/bin/env python3
"""SMTP 网关测试(M2):连 465 SMTPS,验证 AUTH → 发信流程

用法:python3 test-smtp.py [host] [email] [password]
默认连本机 10465(mock 环境);传参连真实环境(如 imap.example.com)
"""
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate

HOST = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 10465
USER = sys.argv[3] if len(sys.argv) > 3 else 'user@example.com'
PASS = sys.argv[4] if len(sys.argv) > 4 else 'pass123'
FROM = sys.argv[5] if len(sys.argv) > 5 else USER

passed = 0
failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  ✅ {name}')
    else:
        failed += 1
        print(f'  ❌ {name} {detail}')


def main():
    print(f'=== SMTP 连接 {HOST}:{PORT} ({"明文" if HOST == "127.0.0.1" else "SMTPS"}) ===')
    if HOST == '127.0.0.1':
        s = smtplib.SMTP(HOST, PORT, timeout=10)
    else:
        ctx = ssl.create_default_context()
        s = smtplib.SMTP_SSL(HOST, PORT, context=ctx, timeout=10)
    check('连接成功', True)

    # EHLO + 能力
    code, resp = s.ehlo()
    check(f'EHLO 成功 ({code})', code == 250)

    print('=== 错误密码应被拒绝 ===')
    try:
        s.login(USER, 'wrong-pass')
        check('错误密码被拒绝', False, '(竟然成功)')
    except smtplib.SMTPAuthenticationError:
        check('错误密码被拒绝', True)

    print('=== 登录 ===')
    try:
        s.login(USER, PASS)
        check('登录成功', True)
    except smtplib.SMTPAuthenticationError as e:
        check('登录成功', False, str(e))
        sys.exit(1)

    print('=== 发送测试邮件 ===')
    msg = EmailMessage()
    msg['From'] = FROM
    msg['To'] = USER
    msg['Subject'] = 'SMTP 网关测试'
    msg['Date'] = formatdate(localtime=True)
    msg.set_content('这是一封 SMTP 网关测试邮件,中文正文验证。\n第二行。')
    msg.add_alternative('<h1>SMTP 网关测试</h1><p>中文 <strong>加粗</strong> 正文</p>', subtype='html')

    try:
        s.send_message(msg)
        check('邮件发送成功 (250)', True)
    except Exception as e:
        check('邮件发送成功 (250)', False, str(e))

    s.quit()
    print(f'\n结果: {passed} 通过, {failed} 失败')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
