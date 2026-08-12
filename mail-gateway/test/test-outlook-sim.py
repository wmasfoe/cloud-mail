#!/usr/bin/env python3
"""模拟 Outlook 发送后验证流程(不真发信,纯 IMAP 协议验证)

复刻 Outlook 日志中的命令序列:
  APPEND "Sent" (\Seen) {size}  → 副本进 Sent
  SELECT "Sent"
  UID FETCH 1:* (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])
  UID SEARCH 1:* SINCE <date>
验证:APPEND OK、UID FETCH 返回、UID SEARCH 能找到刚 append 的 UID
"""
import imaplib
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 1143
USER = sys.argv[3] if len(sys.argv) > 3 else 'user@example.com'
PASS = sys.argv[4] if len(sys.argv) > 4 else 'pass123'

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
    if HOST == '127.0.0.1':
        m = imaplib.IMAP4(HOST, PORT)
    else:
        m = imaplib.IMAP4_SSL(HOST, PORT)

    # 登录
    m.login(USER, PASS)
    check('登录成功', True)

    # 模拟 Outlook 发送的副本(MIME 带 Message-ID)
    msg_id = f'<outlook-sim-{int(time.time())}@example.app>'
    mime = (
        'From: user <user@example.com>\r\n'
        'To: friend@example.com\r\n'
        'Subject: outlook simulation\r\n'
        f'Message-ID: {msg_id}\r\n'
        'Date: ' + imaplib.Time2Internaldate(time.time()) + '\r\n'
        'MIME-Version: 1.0\r\n'
        'Content-Type: text/plain; charset=utf-8\r\n'
        '\r\n'
        'outlook simulation body\r\n'
    ).encode('utf-8')

    print('=== 1. APPEND Sent(副本)===') 
    typ, data = m.append('Sent', '\\Seen', imaplib.Time2Internaldate(time.time()), mime)
    check('APPEND 返回 OK', typ == 'OK', str(data))

    print('=== 2. SELECT Sent ===')
    typ, data = m.select('Sent')
    check('SELECT Sent OK', typ == 'OK')
    exists = int((data[0] or b'0').decode())
    check(f'Sent 有邮件 ({exists})', exists > 0)
    print(f'  (Sent 共 {exists} 封)')

    print('=== 3. UID FETCH 1:* (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]) ===')
    typ, data = m.uid('fetch', '1:*', '(UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])')
    check('UID FETCH 返回 OK', typ == 'OK', str(data))
    found = False
    for item in data:
        if isinstance(item, tuple):
            head = item[1].decode('utf-8', errors='replace')
            if msg_id in head:
                found = True
    check(f'FETCH 结果包含刚 append 的 Message-ID ({msg_id})', found)

    print('=== 4. UID SEARCH 1:* SINCE(今天)===')
    today = time.strftime('%d-%b-%Y', time.gmtime())
    typ, data = m.uid('search', None, f'(SINCE {today})')
    check('UID SEARCH 返回 OK', typ == 'OK', str(data))
    uids = (data[0] or b'').decode().split()
    check(f'UID SEARCH 有结果 ({uids})', len(uids) > 0, str(uids))

    print('=== 5. UID SEARCH ALL(对照)===')
    typ, data = m.uid('search', None, 'ALL')
    uids_all = (data[0] or b'').decode().split()
    check(f'UID SEARCH ALL 有结果 ({uids_all})', len(uids_all) > 0)

    m.logout()
    print(f'\n结果: {passed} 通过, {failed} 失败')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
