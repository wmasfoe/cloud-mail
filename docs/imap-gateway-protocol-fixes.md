# IMAP 网关协议兼容修复记录(Outlook/iOS)

> 日期:2026-08-12 · 关联提交:`ede335b` → `32a4081` → `dc9e472`
> 场景:Outlook 发信"显示失败但邮件实际已发出,退回草稿箱",经 wrangler tail + IMAP 调试日志定位,逐层修复。

## 一、问题现象

- Outlook 发信:**收件方收到邮件,但 Outlook 报"电子邮件 'x' 同步失败,已退回草稿文件夹"**
- 网关日志显示 SMTP 发送成功(250 已回复),邮件也 APPEND 到了 Sent
- 根因在 **IMAP 侧的"发送后验证"环节**,不在 SMTP

## 二、Outlook 的发送事务(为什么"成功"还报错)

```
1. 存草稿(本地/服务器)             ← 中间态
2. SMTP 发送 → 网关 250          ✅(邮件已发出)
3. 副本 APPEND 到 Sent           ✅
4. 验证副本:
   - UID FETCH ... BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]  ← 找副本的 Message-ID
   - UID SEARCH 1:* SINCE <date>                          ← 按日期找刚发的邮件
5. 事务完成;任一步失败 → 整个发送标记失败
```

**邮件发出(第 2 步)但第 4 步验证失败 → Outlook 判定事务未完成** → 类似"钱到账但 App 确认失败"。

## 三、修复清单(按根因)

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | HEADER.FIELDS 返回整封邮件 | `parseFetchItems` 把 `BODY.PEEK[HEADER.FIELDS (X Y)]` 拆成两个 item(未考虑 `[]` 内括号);兜底分支返回完整 MIME | `[]` 内括号不参与切分;新增精确分支只返回请求字段 + 空行(RFC 3501) |
| 2 | UID SEARCH 被误当 UID FETCH | dispatch 的 `UID` case 未分流 SEARCH | `args[0]==='SEARCH'` → cmdSearch(isUid=true,返回 UID) |
| 3 | SEARCH 不支持 SINCE | cmdSearch 只支持 ALL/UNSEEN/RECENT | 支持 `SINCE dd-Mon-yyyy`(UTC 当日 0 点比较) |
| 4 | SEARCH 括号参数解析失败 | `(SINCE date)` 整体当一个参数 | strip 首尾括号 |
| 5 | 已读/未读语义反转 | D1 `unread=1`=已读,代码取反 | `\Seen` 比较统一大写;`+FLAGS`→已读,`-FLAGS`→未读 |
| 6 | UID STORE 失效 | `UID STORE` 进 cmdFetchOrUid 被当 FETCH | dispatch 分流 `args[0]==='STORE'` → cmdStore(isUid=true,按 UID 映射) |
| 7 | `\Deleted` 立即删邮件 | STORE +Deleted 直接写 D1 `is_del=1`,邮件从列表消失(客户端序号错乱,EXPUNGE 无从删起) | `\Deleted` 仅内存标记;EXPUNGE 时才调 Worker 真删 |
| 8 | EXPUNGE splice 升序 | 相邻索引删错对象 | 降序 splice |
| 9 | APPEND flags 丢失 | `APPEND "Sent" (\Seen)` 的 flags 未解析 | 解析 `(\Seen)` → `seen` 传给 Worker append 接口 |
| 10 | 隐式 `\Seen` 不持久化 | 非 PEEK 读取只改内存 | `persistSeen()` 调 client.flags 写 D1 |
| 11 | 附件二进制损坏 | MIME 经 JSON 字符串传输(UTF-8 替换) | 网关 ↔ Worker 全链路 base64 传输(send/append/email/:id) |
| 12 | HEADER literal 缺空行 | 头部 literal 以字段行结尾 | 补 `\r\n\r\n`(RFC:blank line 总是包含) |

## 四、验证方法(三层)

1. **本地回归**:`test-imap.py`(22 项)+ `test-smtp.py`(5 项)+ `test-outlook-sim.py`(9 项,模拟 Outlook 发送后验证序列,新增)——全绿
2. **独立 agent 审查**:通读 imap.js + 交叉核对 D1 `unread` 语义,发现 4 高 + 4 中高 + 5 中低问题,全部修复
3. **RFC 3501 核对**:HEADER.FIELDS 响应格式(`BODY[HEADER.FIELDS (SUBJECT)] {18}` + `Subject: crash\r\n\r\n`)、`\Seen` 隐式设置、STORE/APPEND 语法
4. **原始 socket 抓包**:直接看服务器原始响应行,确认 `BODY[HEADER.FIELDS (MESSAGE-ID SUBJECT)] {55}` 内容仅含请求字段

## 五、部署要点

- Worker:`npx wrangler deploy --keep-vars`(wrangler 4.90 只有 `--keep-vars`)
- **custom domain 路由需要 token 有 Zone → Workers Routes → Edit 权限**,否则部署时报 `Authentication error [code: 10000]`(代码会上传成功,但路由设置失败)
- 网关:/opt/mail-gateway(imap.js + client.js 同步后 `systemctl restart mail-gateway`)
- 调试:`.env` 设 `IMAP_DEBUG=true` 记录所有 IMAP 命令;`wrangler tail --format json` 看 Worker 请求

## 六、经验教训

- **IMAP flags 大小写不敏感**:客户端发 `\Seen`,统一 `toUpperCase()` 后与 `\SEEN` 比较,常量按大写定义
- **`unread` 字段语义反直觉**:D1 `unread=1` = 已读(网页端模型),网关内部用 `msg.unread`(true=已读),命名极易混淆
- **客户端"发送成功"是一个事务**:SMTP 250 ≠ 客户端判定成功;Outlook/iOS 发送后还有 APPEND/验证环节
- **测试脚本要有状态隔离**:mock 常驻进程会被多轮测试污染(邮件被删),回归前重启 mock
- **imaplib 响应显示会简化**(`BODY[HEADER.FIELD]`),怀疑协议问题要用原始 socket 抓包
