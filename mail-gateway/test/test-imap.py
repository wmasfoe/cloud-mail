#!/usr/bin/env python3
"""IMAP 网关功能测试(Python 标准库 imaplib,零依赖)

验证:
1. LOGIN 认证(正确/错误密码)
2. LIST 列出 INBOX / Sent
3. SELECT 返回 EXISTS / UIDVALIDITY / UIDNEXT
4. UID FETCH 按 UID 取邮件头与全文
5. SEARCH ALL
6. STORE 标记已读 + 验证 flags 接口收到写入
"""
import imaplib
import sys

HOST = '127.0.0.1'
PORT = 1143
USER = 'user@example.com'
PASS = 'pass123'

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


def data_to_text(data):
    """把 imaplib 返回的 data(混合 bytes/tuple)解成可读文本"""
    parts = []
    for item in data:
        if isinstance(item, tuple):
            parts.append(item[0].decode('utf-8', errors='replace'))
            parts.append(item[1].decode('utf-8', errors='replace'))
        elif isinstance(item, bytes):
            parts.append(item.decode('utf-8', errors='replace'))
    return '\n'.join(parts)


def main():
    print('=== 1. 认证 ===')
    m = imaplib.IMAP4(HOST, PORT)
    m.login(USER, PASS)
    check('LOGIN 正确密码', True)

    # 错误密码
    m2 = imaplib.IMAP4(HOST, PORT)
    try:
        m2.login(USER, 'wrong-pass')
        check('LOGIN 错误密码被拒绝', False, '(竟然成功了)')
    except imaplib.IMAP4.error:
        check('LOGIN 错误密码被拒绝', True)
    m2.logout()

    print('=== 2. LIST ===')
    typ, data = m.list()
    check('LIST 成功', typ == 'OK')
    names = b' '.join(d for d in data if isinstance(d, bytes))
    check('包含 INBOX', b'INBOX' in names)
    check('包含 Sent', b'Sent' in names)

    print('=== 3. SELECT INBOX ===')
    typ, data = m.select('INBOX')
    check('SELECT 成功', typ == 'OK')
    exists = int((data[0] or b'0').decode())
    check('EXISTS = 3(收件箱 3 封)', exists == 3, f'(实际 {exists})')

    typ, data = m.status('INBOX', '(MESSAGES UNSEEN UIDVALIDITY UIDNEXT)')
    check('STATUS 成功', typ == 'OK')

    print('=== 4. UID FETCH 邮件头 ===')
    typ, data = m.uid('fetch', '102', '(FLAGS UID BODY.PEEK[HEADER])')
    check('UID FETCH 102 成功', typ == 'OK')
    raw = data_to_text(data)
    check('含 UID 102', 'UID 102' in raw)
    check('含 \Flagged(星标)', '\\Flagged' in raw)
    print('=== 5. UID FETCH 全文(中文邮件) ===')
    typ, data = m.uid('fetch', '102', '(BODY.PEEK[])')
    check('BODY[] 拉取成功', typ == 'OK')
    text = data_to_text(data)
    check('中文主题可解码', '测试邮件' in text, '(若失败说明 RFC2047 解码问题)')
    check('含中文正文', '中文测试邮件' in text)
    check('含粗体 HTML', '<strong>粗体</strong>' in text)

    print('=== 6. SEARCH ALL ===')
    typ, data = m.search(None, 'ALL')
    check('SEARCH ALL 返回 3 条', typ == 'OK' and len(data[0].split()) == 3, f'(实际 {data})')

    print('=== 7. STORE 标记已读 + 星标 ===')
    typ, data = m.uid('store', '101', '+FLAGS', '(\\Seen \\Flagged)')
    check('STORE 成功', typ == 'OK')
    raw = str(data)
    check('响应含 FLAGS', 'FLAGS' in raw and '\\Seen' in raw)

    print('=== 8. 重新拉取验证 flags 状态已变 ===')
    typ, data = m.uid('fetch', '101', '(FLAGS)')
    check('101 已标记 \\Seen', '\\Seen' in data_to_text(data))

    print('=== 9. IDLE 基本流程(连接→idling→DONE) ===')
    sock = m.sock
    if sock:
        sock.settimeout(5)
        try:
            sock.sendall(b'TAGIDLE IDLE\r\n')
            resp = sock.recv(1024).decode()
            check('IDLE 返回 + idling', resp.startswith('+'))
            sock.sendall(b'DONE\r\n')
            resp = sock.recv(1024).decode()
            check('DONE 后返回 OK', 'OK' in resp.upper())
        except Exception as e:
            check('IDLE 基本流程', False, str(e))
    else:
        check('IDLE 基本流程', False, 'socket 不可用')

    print('=== 10. LOGOUT ===')
    typ, data = m.logout()
    check('LOGOUT 成功', typ == 'BYE')

    print(f'\n结果: {passed} 通过, {failed} 失败')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
