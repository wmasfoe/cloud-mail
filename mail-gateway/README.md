# cloud-mail IMAP 网关 — 部署文档

无状态 IMAP 网关:在任意 VPS 上运行,数据源为 Cloudflare D1/R2(单一数据源)。
**不需要端口 25**(收信走 Cloudflare Email Routing,发信走 API 通道)。
本机已验证:mock 环境 22/22 协议测试通过。

> 前置版本:M1(IMAP 只读 + STORE/EXPUNGE + 伪 IDLE;SMTP 发信网关在 M2,当前客户端发信请用网页端)

---

## 1. 架构总览

```
iOS/Outlook/Thunderbird
   │  IMAP 993(TLS)
   ▼
┌──────────────────────────┐
│ mail-gateway (VPS, Node) │  无状态,不存任何邮件数据
└──────────┬───────────────┘
           │ HTTPS + GATEWAY_KEY
           ▼
┌──────────────────────────┐
│ Cloudflare Worker        │  Email Routing 收信 / API 发信
└──────┬──────────┬────────┘
     D1(元数据)  R2(原始MIME+附件)   ← 唯一数据源
```

## 2. 前置条件

| 项 | 要求 |
|---|---|
| VPS | 任意 1C/512MB+ 的 Linux(Debian 12+ / Ubuntu 22.04+,x86_64/aarch64),公网可达 |
| 域名 | 托管在 Cloudflare,且 **cloud-mail Worker 已部署**并可用 |
| 端口 | 入站放行 **993**(IMAP);**不需要 25** |
| Worker 端 | 已部署含 `/api/gateway/*` 的版本,已设置 `gateway_key`(见 §3) |

## 3. 第一步:部署 Worker 端(一次性)

> 如果你已经在跑 cloud-mail 的 Worker,只需更新到含 gateway 接口的版本并设置 `gateway_key`。

```bash
# 在能访问 Cloudflare 账号的机器上(或 GitHub Actions)
cd mail-worker
wrangler login                      # 浏览器授权
wrangler deploy                     # 或:使用你现有的部署方式(wrangler-action.toml)

# 设置网关密钥(用任意随机串,记下来,VPS 端 .env 要用同一个值)
wrangler secret put gateway_key     # 或 dashboard → Workers → Settings → Variables
```

生成密钥示例:`openssl rand -hex 32`

**验证 Worker 端就绪:**
```bash
curl -s -X POST https://<你的域名>/api/gateway/auth \
  -H "Authorization: Bearer <gateway_key>" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"你的密码"}'
# 期望:{"code":200,"data":{"userId":...,"email":"...","accounts":[...]}}
```

## 4. 第二步:VPS 上部署网关(换 VPS 时重复本步)

```bash
# 1. 拉代码(任意目录)
git clone git@github.com:wmasfoe/cloud-mail.git
cd cloud-mail/mail-gateway/deploy

# 2. 配置(关键!)
cp .env.example .env
vim .env
#   必填:
#     API_BASE_URL   = https://<你的cloud-mail域名>
#     GATEWAY_KEY    = 与 Worker 端 gateway_key 完全一致
#   推荐(自动签发 TLS):
#     TLS_DOMAIN     = imap.yourdomain.com(需先建 A 记录指向本机 IP)
#     CF_DNS_API_TOKEN = Cloudflare token(DNS:Edit 权限)
#     CERTBOT_EMAIL  = 你的邮箱

# 3. 一键安装(自动:Node.js → 用户 → 代码 → systemd → 防火墙 → TLS → 启动)
sudo bash install.sh
```

脚本完成后的输出会提示:`✅ 部署完成`。

## 5. 第三步:验证

```bash
# 服务状态与日志
systemctl status mail-gateway
journalctl -u mail-gateway -f

# TLS 握手验证(如果配了 TLS)
openssl s_client -connect <VPS_IP>:993 -quiet </dev/null 2>/dev/null | head -3

# 协议级验证(本机,需装 python3)
cd cloud-mail/mail-gateway
python3 test/test-imap.py          # 22 项断言:登录/列目录/取信/中文/星标/STORE/IDLE
```

## 6. 第四步:iOS 邮件配置

1. 设置 → 邮件 → 账户 → 添加账户 → 其他 → 添加邮件账户
2. 填邮箱 `you@example.com` + 密码(**cloud-mail 账号密码**)
3. 收件服务器(IMAP):
   - 主机名:`imap.yourdomain.com`(或 VPS IP)
   - 端口:`993`,SSL ✅
4. 发件服务器(SMTP):M2 前可留空/跳过;用网页端发信

> 说明:登录名用**用户邮箱**(user 表 email),收件箱展示该用户名下全部 account 的收件。

## 7. 运维

| 操作 | 命令 |
|---|---|
| 看日志 | `journalctl -u mail-gateway -f` |
| 重启 | `sudo systemctl restart mail-gateway` |
| 更新代码 | `git pull` + `sudo bash install.sh`(幂等,重跑安全) |
| 证书续期 | 自动(timer 每天检查);手动:`sudo certbot renew` |
| 备份 | **无需备份** —— 数据全在 D1/R2,网关无状态;换机器 = 重跑本脚本 |

## 8. 故障排查

| 症状 | 排查 |
|---|---|
| 客户端"无法验证服务器" | ① 993 端口未放行(云安全组 + 本机 ufw)② TLS 证书未配置或域名不匹配 |
| 登录失败 | ① `GATEWAY_KEY` 与 Worker 端不一致 ② 密码错误 ③ Worker 端未设置 `gateway_key` |
| 登录成功但收件箱空 | `API_BASE_URL` 指向错误;或该用户名下确实无收件 |
| 中文邮件乱码 | 网关按 UTF-8 处理,确认原始 MIME 正常(新邮件 R2 原文,老邮件回退组装) |
| 新邮件不推送 | IDLE 为 30s 轮询(设计如此);检查 `IDLE_POLL_MS` 与网关日志 |

## 9. 已知限制(M1)

- SMTP 发信网关未实现(M2):客户端发信暂用网页端
- SEARCH 仅支持 ALL/UNSEEN
- 无 QUOTA/ACL/多邮箱层次
- 老邮件(无 R2 原始 MIME)由 Worker 端按 D1 字段 + 附件重组

## 10. 设计文档

架构与接口细节见 [docs/imap-gateway-design.md](../../docs/imap-gateway-design.md)。
