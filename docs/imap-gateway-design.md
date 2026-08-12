# cloud-mail 第三方客户端接入(IMAP/SMTP 网关)设计文档

> 状态:草稿(v0.1,待 review)
> 日期:2026-08-12
> 范围:在现有 cloud-mail(Cloudflare Workers 邮箱)基础上,新增 IMAP/SMTP 网关,
> 使 iOS 邮件 / Gmail / Outlook 等第三方客户端可以收发邮件,同时**保持 D1/R2 为唯一数据源**。

---

## 1. 背景与目标

### 1.1 现状

- **收信**:Cloudflare Email Routing → Worker(`mail-worker/src/email/email.js`,PostalMime 解析)→ 元数据存 D1(`email` 表)、附件存 R2(`attachments` 表记录 key)
- **发信**:网页端 → Resend API(或 CF Email Service)发送
- **存储**:D1(邮件元数据)+ R2(附件)+ KV(缓存),全部在 Cloudflare
- **局限**:只有网页端(`mail-vue`)能查看和发送,第三方邮件客户端无法接入

### 1.2 目标

让第三方客户端(iOS 邮件、Gmail App、Outlook、Thunderbird)通过标准协议接入:

| 方向 | 协议 | 端口 |
|---|---|---|
| 收信 | IMAP | 993(SSL) |
| 发信 | SMTP submission | 587(STARTTLS)/465(SMTPS) |

### 1.3 硬性约束(需求方明确要求)

1. **单一数据源**:D1/R2 是唯一事实来源,不允许在 VPS 上再存一份邮件数据(否决了 Stalwart/WildDuck 等本地存储方案及"双写桥"方案)
2. **VPS 无状态**:VPS 只是协议翻译层,挂掉不影响收信、不影响网页端,恢复即用
3. **不需要 25 端口**:收信走 Cloudflare Email Routing(MX 不动),发信走 API 通道,均不依赖 VPS 的 25 端口(入站/出站)
4. **不影响现有流程**:网页端收发、管理后台、现有 API 全部保持原样;新增能力以"外围组件"方式接入
5. **认证最小权限**:网关访问 Worker 的凭证独立、最小授权

---

## 2. 总体架构

```
第三方客户端(iOS 邮件 / Gmail / Outlook / Thunderbird)
        │
        │  IMAP 993(收信)  SMTP 587/465(发信)
        ▼
┌──────────────────────────────────┐
│  mail-gateway  (VPS, Node.js)    │  ← 新增组件,无状态
│  · IMAP 协议层(自研,轻量子集)    │
│  · SMTP submission 层            │
│  · 与 Worker 通过 HTTPS 通信     │
└──────────────┬───────────────────┘
               │ HTTPS(网关专用 token,最小权限)
               ▼
┌──────────────────────────────────┐
│  Cloudflare Worker (Hono)        │  ← 现有,新增少量只读/写入接口
│  · Email Routing 收信(不变)      │
│  · 发信:CF Email Service / Resend│
└──────┬──────────────┬────────────┘
       ▼              ▼
      D1(元数据)     R2(原始MIME + 附件)   KV(缓存)
     (唯一数据源)
```

**收信链路(现有,基本不变)**:
```
发件人 → MX(Cloudflare) → Worker 收到完整 MIME
      → ①解析后元数据写 D1(现有逻辑)
      → ②【新增】原始 MIME 原文存 R2
```

**客户端收信链路(新增)**:
```
客户端 → IMAP 993 → mail-gateway → 调 Worker 查询接口 → 读 D1/R2 → 返回 IMAP 响应
```

**客户端发信链路(新增)**:
```
客户端 → SMTP 587 → mail-gateway → 调 Worker 发信接口 → CF Email Service 发送
      → Worker 写回 D1(type=SEND,status=SENT)→ 网页端可见已发送
```

---

## 3. 数据模型

### 3.1 现有表(已核实,不修改)

**`email` 表**(`mail-worker/src/entity/email.js`):

| 列 | 类型 | 与 IMAP 的映射 |
|---|---|---|
| `email_id` | INTEGER 自增主键 | **直接作为 IMAP UID**(单调递增、稳定,删除后不复用,天然满足协议要求) |
| `account_id` / `user_id` | INTEGER | 邮箱归属(IMAP 登录用户 ↔ 其全部 account) |
| `type` | INTEGER | 0=收(RECEIVE)→ INBOX;1=发(SEND)→ Sent |
| `status` | INTEGER | 0=收到,1=已发送,2=已送达... |
| `unread` | INTEGER | 0=未读 → `\Seen` 未设置;1=已读 → `\Seen` 设置 |
| `is_del` | INTEGER | 0=正常,1=软删除 → `\Deleted` / EXPUNGE |
| `subject` / `text` / `content` | TEXT | 主题 / 纯文本正文 / HTML 正文(用于 MIME 重组回退) |
| `message_id` | TEXT | 标准 Message-ID(重组 MIME 头时使用) |
| `send_email` / `to_email` / `to_name` / `cc` / `bcc` | TEXT | 信封信息 |
| `in_reply_to` / `relation` | TEXT | 引用关系(重组头时使用) |
| `create_time` | TEXT | 邮件时间(重组 Date 头) |

**`attachments` 表**(`mail-worker/src/entity/att.js`):`att_id`、`email_id`、`key`(R2 对象 key)、`filename`、`mime_type`、`size`、`disposition`、`related`、`content_id`、`encoding` —— 素材齐全,可完整重组 MIME。

**`star` 表**:`star_id`、`user_id`、`email_id` —— 存在记录 = IMAP `\Flagged`(星标)。

**`account` 表**:`account_id`、`email`(完整邮箱地址)、`user_id` —— IMAP 登录邮箱 ↔ 用户 ↔ 邮件归属。

**`user` 表**:`user_id`、`email`、`password`、`salt` —— 认证信息(哈希算法见现有 service 实现,网关不复制,委托 Worker 校验)。

### 3.2 改动清单(最小化)

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| 1 | 收信时把原始 MIME 存 R2 | `mail-worker/src/email/email.js` | 现有代码已读 `message.raw`,只需多一步 `env.r2.put('raw/' + emailId + '.eml', raw)`。key 规则:`raw/{email_id}.eml` |
| 2 | `email` 表新增一列(可选) | `entity/email.js` + D1 migration | `raw_key TEXT`(原始 MIME 的 R2 key)。**不做 migration 也可以**:用固定规则 `raw/{email_id}.eml` 推导,缺了就用老邮件组装回退 |
| 3 | 新增 `imap_mailbox` 表(可选,用于 UIDVALIDITY) | 新 entity | 每 (user_id, mailbox) 存 `uidvalidity INTEGER`。**第一版可用固定值**(如账号创建时间戳 hash),后续再迁移 |

> 设计决策:**优先用固定 key 规则推导 raw MIME,不新增列**;UIDVALIDITY 用可推导的固定值。目标是把 D1 schema 改动降到"零新列"。

---

## 4. Worker 新增 API(网关契约)

统一前缀 `/api/gateway/*`,认证用网关专用 key(与现有 X-API-Key 体系分离)。

| 接口 | 方法 | 用途 | 说明 |
|---|---|---|---|
| `POST /api/gateway/auth` | 登录校验 | 网关把 IMAP/SMTP 凭证发给 Worker,返回 user_id + 可用 account 列表 | **网关不复制哈希逻辑**,认证只有一处实现 |
| `GET /api/gateway/mailboxes?userId=` | 邮箱目录 | 返回该用户的收件/已发送等目录及 UIDVALIDITY、最新 email_id(水位线) | |
| `GET /api/gateway/emails?accountId=&folder=&sinceEmailId=&limit=` | 列表/增量拉取 | 网关轮询新邮件、分页同步 | 返回 email_id、flags、基础头 |
| `GET /api/gateway/email/:id` | 取完整邮件 | 返回 RFC5322 格式的 MIME | 优先 R2 原始 MIME,回退组装 |
| `POST /api/gateway/email/:id/flags` | 更新状态 | body:`{unread?, starred?, deleted?}` → 写 D1(`unread`/`star`/`is_del`) | |
| `POST /api/gateway/send` | 发信 | body: MIME 或结构化字段 → Worker 走 CF Email Service(优先)/Resend(回退)发送,成功写回 D1(type=SEND) | 与现有发信 service 复用 |

**权限要求**:网关 token 仅可调用上述接口,**不可**调用管理类接口(用户管理、设置、备份等)。实现:Worker 中新增独立中间件,检查 `Authorization: Bearer <gateway-key>`(env `GATEWAY_KEY`)。

---

## 5. IMAP 网关设计

### 5.1 技术选型

- **语言/运行时**:Node.js 20+(与 mail-worker 同栈,复用 `postal-mime` 做 MIME 解析)
- **TLS**:网关自身管理证书(Let's Encrypt / Caddy 反代),993 为 SSL 直连
- **部署**:独立 systemd 服务(或 Docker),无状态,不落盘邮件数据(内存/临时缓存除外)

### 5.2 第一版命令子集(PoC 范围)

| 命令 | 实现方式 |
|---|---|
| `CAPABILITY` / `NOOP` / `LOGOUT` | 固定响应 |
| `LOGIN` / `AUTHENTICATE PLAIN` | 调 `/api/gateway/auth` |
| `LIST` / `LSUB` | 返回 INBOX、Sent(后续加 Drafts/Trash) |
| `SELECT` / `EXAMINE` | 返回 `UIDVALIDITY`、`UIDNEXT`(max email_id + 1)、`EXISTS`、`FLAGS` |
| `FETCH` / `UID FETCH` | `BODY[]`、`BODY.PEEK[]`、`FLAGS`、`ENVELOPE`、`RFC822.HEADER`、`UID` —— 数据来自 `/api/gateway/email/:id` |
| `STORE` / `UID STORE` | `+FLAGS \Seen / \Flagged / \Deleted` → 调 flags 接口写 D1 |
| `EXPUNGE` / `UID EXPUNGE` | `is_del=1`(软删除,与网页端删除语义一致) |
| `SEARCH` | 按主题/发件人/日期/未读 → D1 LIKE 查询(第一版可只做基础子集) |
| `IDLE` | **轮询式**:每 30s 调列表接口对比 `sinceEmailId`,有新邮件发 untagged `EXISTS` |

**第一版明确不实现**:QUOTA、ACL、SORT/THREAD(可选后加)、多设备并发冲突的高级语义。

### 5.3 关键语义设计

| 项 | 决策 | 理由 |
|---|---|---|
| **UID** | = `email_id`(自增整数) | 天然单调递增、稳定、不复用;零映射表 |
| **UIDVALIDITY** | 每个邮箱固定值(如 `account_id` 派生或部署时写入 KV) | 邮箱内 UID 语义永久不变;客户端不会"邮箱被重置" |
| **UIDNEXT** | `max(email_id) + 1` | 直接查询得出 |
| **邮箱目录** | INBOX = `type=0`;Sent = `type=1` | 与现有 type 字段一一对应 |
| **\Seen** | `unread == 1`(注意:现有语义 0=未读,1=已读) | 直接映射 |
| **\Flagged** | `star` 表存在记录 | 直接映射 |
| **\Deleted** | `is_del == 1` | 与网页端"软删除"同一语义,天然一致 |
| **MIME 获取** | ① R2 原始 MIME(`raw/{id}.eml`)→ ② 回退:用 D1 字段 + attachments 表重组 | 新邮件零成本;老邮件兼容 |
| **多客户端一致性** | 客户端标记已读 → D1 → 网页端/其他客户端可见(单一数据源的直接收益) | |

### 5.4 性能考量

- **轮询水位线**:`sinceEmailId` 增量查询走 `email_id` 主键索引,D1 开销极小
- **首次全量同步**:分页拉取(`limit` + `sinceEmailId`),避免一次拉爆;iOS 全量拉头时网关按页喂数据
- **MIME 组装缓存**:老邮件组装结果可按 email_id 缓存在 KV(可选,后续优化)

---

## 6. SMTP 网关设计

| 项 | 决策 |
|---|---|
| 监听 | 587(STARTTLS,主)+ 465(SMTPS,备) |
| 认证 | `AUTH LOGIN` / `AUTH PLAIN` → 调 `/api/gateway/auth`(与 IMAP 同一验证通道) |
| 发信流程 | 收到完整 MIME → `postal-mime` 解析 → `POST /api/gateway/send` → Worker 走 CF Email Service(优先)/ Resend(回退) → 成功返回 `250 OK`;失败返回 `451`(客户端自动重试) |
| 回写 | Worker 发送成功后将邮件写回 D1(`type=SEND`),**网页端和客户端看到的"已发送"是同一份数据** |
| 附件 | 随 MIME 一起传给 send 接口(复用现有发信附件逻辑,R2 存储) |

---

## 7. 认证与安全

| 层 | 方案 |
|---|---|
| 传输层 | IMAP 993 直连 SSL;SMTP 587 STARTTLS;证书 Let's Encrypt(Caddy 自动续期) |
| 网关 ↔ Worker | 网关专用 key(env `GATEWAY_KEY`),仅授权 gateway 接口;密钥不落盘日志 |
| IMAP/SMTP 登录 | 委托 Worker 校验(`/api/gateway/auth`),网关不接触密码哈希;**推荐后续支持 app-specific password**,避免客户端持有主密码 |
| VPS 防火墙 | 只开放 993/587(公网),其余端口(网关管理端口等)仅内网;不开放 25(无需) |
| 攻击面 | 网关为无状态 Node 服务,不存储任何凭据/邮件;被攻破影响面 = 可读该用户的邮件,可通过 gateway token 的最小授权 + 限流(登录失败次数限制)降低风险 |

---

## 8. 故障模式与影响分析

| 故障 | 收信 | 网页端收发 | 客户端 | 恢复 |
|---|---|---|---|---|
| VPS 宕机 | ✅ 正常(D1 照常进信) | ✅ 正常 | ❌ 暂时连不上 | 拉起网关进程即恢复(无状态,无需补数据) |
| 网关进程崩溃 | ✅ | ✅ | ❌ | systemd 自动重启 |
| 网关 ↔ Worker 网络故障 | ✅ | ✅ | 读/写暂时失败(客户端重试) | 网络恢复自动好 |
| Worker 故障 | ❌(整体宕,既有风险,与本次无关) | ❌ | ❌ | — |
| R2 原始 MIME 缺失(老邮件) | — | — | 回退组装,仍可读 | — |

**关键结论:网关不在收信关键路径上,也不持有任何数据,VPS 故障零数据风险。**

---

## 9. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M1 PoC** | ① Worker:收信存 raw MIME 到 R2 ② 新增 auth/列表/取信 3 个接口 ③ 网关:IMAP 只读(LOGIN/LIST/SELECT/UID FETCH) | **iOS 邮件 App 能登录并看到收件箱邮件**(可先不做 Sent/写操作) |
| **M2 闭环** | ④ flags 接口 + STORE/EXPUNGE ⑤ SMTP 发信闭环(587→send 接口→CF Email Service→回写 D1) | iOS 能标记已读/删除;能发信,网页端看到已发送 |
| **M3 完善** | ⑥ IDLE 轮询推送 ⑦ SEARCH 基础子集 ⑧ 老邮件 MIME 组装回退 ⑨ Sent 文件夹 | 新邮件秒级到达;发件箱可见;老邮件可读 |
| **M4 加固** | ⑩ 登录限流/失败锁定 ⑪ app-specific password ⑫ 日志与监控 ⑬ systemd/Docker 部署脚本与文档 | 可长期稳定运行 |

> 每阶段完成都需回归验证:**网页端收发、管理后台不受影响**(铁律)。

---

## 10. 仓库结构(建议)

```
cloud-mail/
├── mail-worker/        # Cloudflare Worker —— 现有,不动(仅按 §3.2/§4 增量加代码)
├── mail-vue/           # 前端 —— 不动
├── doc/                # 上游文档 —— 不动
├── docs/               # 新增:设计文档(本文件)
└── mail-gateway/       # 新增(M1 起):VPS 端 IMAP/SMTP 网关
    ├── package.json    # 独立依赖(Node.js)
    ├── src/
    │   ├── imap/       # IMAP 协议层(状态机、命令解析、响应编码)
    │   ├── smtp/       # SMTP submission
    │   ├── client/     # Worker API 客户端(token 注入、重试)
    │   └── index.js    # 入口
    ├── deploy/         # systemd unit / Dockerfile / Caddy 配置
    └── README.md       # 部署说明
```

**与上游 maillab 的关系**:所有新增(文档、接口、网关)都在新目录/增量改动中,`mail-worker`/`mail-vue`/`doc` 的目录结构零变化,后续同步 upstream 无冲突。

---

## 附录:验证过的代码事实

- `email_id` 自增主键,可直接作 IMAP UID(`mail-worker/src/entity/email.js`)
- `unread`:0=未读 1=已读(`mail-worker/src/const/entity-const.js` emailConst)
- `type`:0=收 1=发;`is_del` 软删除
- `star` 表按 (user_id, email_id) 记录收藏,可映射 `\Flagged`
- 收信代码已读 `message.raw` 但未保存(`mail-worker/src/email/email.js`)→ 新增存 R2 成本极低
- `attachments` 表含 disposition/content_id/encoding,老邮件 MIME 重组素材齐全
- `user` 表 password + salt 哈希,认证逻辑委托 Worker,网关不复制
