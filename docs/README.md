# cloud-mail 部署文档

本目录为 cloud-mail 的 IMAP/SMTP 网关设计文档与相关说明。

## 文档索引

- [imap-gateway-design.md](./imap-gateway-design.md) — IMAP/SMTP 网关设计文档(v0.1)

## 相关代码

- `mail-worker/src/api/gateway-api.js` — Worker 端网关专用接口(`/api/gateway/*`)
- `mail-worker/src/email/email.js` — 收信时保存原始 MIME 到 R2(第 149 行附近)
- `mail-gateway/` — VPS 端 IMAP 网关(Node.js,零依赖)
