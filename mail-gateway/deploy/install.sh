#!/usr/bin/env bash
# ============================================================
# cloud-mail IMAP 网关一键安装脚本
# 适用:Debian 12+ / Ubuntu 22.04+(x86_64 / aarch64)
# 用法:
#   1. cp .env.example .env 并修改(API_BASE_URL / GATEWAY_KEY / TLS)
#   2. sudo bash install.sh
# 脚本完成:Node.js 安装 → mailgate 用户 → 代码部署到 /opt/mail-gateway
#            → systemd 服务 → 防火墙放行 → 启动验证
# ============================================================
set -euo pipefail

# ---------- 0. 前置检查 ----------
if [[ $EUID -ne 0 ]]; then
	echo "❌ 请用 root 运行:sudo bash install.sh"
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_GATEWAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # 仓库里的 mail-gateway 目录
INSTALL_DIR="/opt/mail-gateway"
SERVICE_NAME="mail-gateway"
SERVICE_USER="mailgate"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
	echo "❌ 未找到 $SCRIPT_DIR/.env,请先: cp .env.example .env 并修改"
	exit 1
fi

echo "=============================================="
echo " cloud-mail IMAP 网关部署"
echo " 安装目录: $INSTALL_DIR"
echo "=============================================="

# ---------- 1. 安装 Node.js 20+(如缺失) ----------
if command -v node >/dev/null 2>&1; then
	NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
	if [[ $NODE_MAJOR -lt 20 ]]; then
		echo "⚠️ 检测到 Node.js v$NODE_MAJOR(需 ≥20),尝试升级..."
		INSTALL_NODE=1
	else
		echo "✅ Node.js $(node -v) 已满足要求"
		INSTALL_NODE=0
	fi
else
	echo "🔧 未检测到 Node.js,开始安装 Node.js 20..."
	INSTALL_NODE=1
fi

if [[ $INSTALL_NODE -eq 1 ]]; then
	# 使用 NodeSource 官方源(支持 Debian/Ubuntu)
	curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
	apt-get install -y nodejs
	echo "✅ Node.js $(node -v) 安装完成"
fi

# ---------- 2. 创建专用用户 ----------
if id "$SERVICE_USER" >/dev/null 2>&1; then
	echo "✅ 用户 $SERVICE_USER 已存在"
else
	useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
	echo "✅ 已创建系统用户 $SERVICE_USER(无登录权限)"
fi

# ---------- 3. 部署代码 ----------
echo "🔧 部署代码到 $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
# 只拷贝运行所需文件(不含 deploy/test,保持干净)
cp -r "$REPO_GATEWAY_DIR/src" "$INSTALL_DIR/"
cp "$REPO_GATEWAY_DIR/package.json" "$INSTALL_DIR/"
# 拷贝 .env(含密钥,权限收紧)
cp "$SCRIPT_DIR/.env" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ---------- 4. 安装 systemd 服务 ----------
echo "🔧 安装 systemd 服务 ..."
cp "$SCRIPT_DIR/mail-gateway.service" /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
systemctl enable $SERVICE_NAME

# ---------- 5. 防火墙放行 ----------
echo "🔧 配置防火墙 ..."
# 读取 IMAP_PORT(.env 里)
IMAP_PORT=$(grep -E '^IMAP_PORT=' "$SCRIPT_DIR/.env" | cut -d= -f2)
IMAP_PORT=${IMAP_PORT:-993}

if command -v ufw >/dev/null 2>&1; then
	ufw allow "$IMAP_PORT"/tcp >/dev/null 2>&1 && echo "✅ ufw 已放行 $IMAP_PORT/tcp" || echo "⚠️ ufw 放行失败,请手动执行: ufw allow $IMAP_PORT/tcp"
elif command -v firewall-cmd >/dev/null 2>&1; then
	firewall-cmd --permanent --add-port="$IMAP_PORT"/tcp >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && echo "✅ firewalld 已放行 $IMAP_PORT/tcp" || echo "⚠️ firewalld 配置失败,请手动放行 $IMAP_PORT/tcp"
else
	echo "⚠️ 未检测到 ufw/firewalld,请手动放行 TCP $IMAP_PORT"
	echo "   (云厂商安全组也需要放行:如 GCP/AWS 控制台 → 防火墙规则)"
fi

# ---------- 5.5 TLS 证书(可选自动签发) ----------
# 如果 .env 里配置了 TLS_DOMAIN + CF_DNS_API_TOKEN,则自动用 certbot DNS 挑战签发证书
TLS_DOMAIN=$(grep -E '^TLS_DOMAIN=' "$SCRIPT_DIR/.env" | cut -d= -f2)
CF_DNS_TOKEN=$(grep -E '^CF_DNS_API_TOKEN=' "$SCRIPT_DIR/.env" | cut -d= -f2)
TLS_CERT=$(grep -E '^TLS_CERT=' "$SCRIPT_DIR/.env" | cut -d= -f2 | sed 's/^=//')
TLS_KEY=$(grep -E '^TLS_KEY=' "$SCRIPT_DIR/.env" | cut -d= -f2 | sed 's/^=//')

if [[ -n "$TLS_DOMAIN" && -n "$CF_DNS_TOKEN" ]]; then
	echo "🔧 检测到 TLS_DOMAIN + CF_DNS_API_TOKEN,自动签发 Let's Encrypt 证书 ..."
	apt-get install -y certbot python3-certbot-dns-cloudflare >/dev/null 2>&1

	CRED_FILE="/etc/letsencrypt/cloudflare.ini"
	cat > "$CRED_FILE" <<EOF
dns_cloudflare_api_token = $CF_DNS_TOKEN
EOF
	chmod 600 "$CRED_FILE"

	if certbot certonly --dns-cloudflare --dns-cloudflare-credentials "$CRED_FILE" \
		-d "$TLS_DOMAIN" --agree-tos --non-interactive --email "$(grep -E '^CERTBOT_EMAIL=' "$SCRIPT_DIR/.env" | cut -d= -f2)" \
		--cert-name mail-gateway --keep-until-expiring; then
		echo "✅ 证书签发成功"

		# 授权 mailgate 用户读取证书(Node 以非 root 运行,letsencrypt 目录默认仅 root 可读)
		apt-get install -y acl >/dev/null 2>&1 || true
		setfacl -R -m u:mailgate:rX /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
		setfacl -R -d -m u:mailgate:rX /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
		echo "✅ 已授权 mailgate 读取证书(含续期新文件)"

		# 把证书路径写回 .env(如果 .env 里没填 TLS_CERT/TLS_KEY)
		CERT_DIR="/etc/letsencrypt/live/mail-gateway"
		if [[ -z "$TLS_CERT" ]]; then
			sed -i "s|^TLS_CERT=.*|TLS_CERT=$CERT_DIR/fullchain.pem|" "$INSTALL_DIR/.env"
			echo "   TLS_CERT 已写入 $CERT_DIR/fullchain.pem"
		fi
		if [[ -z "$TLS_KEY" ]]; then
			sed -i "s|^TLS_KEY=.*|TLS_KEY=$CERT_DIR/privkey.pem|" "$INSTALL_DIR/.env"
			echo "   TLS_KEY 已写入 $CERT_DIR/privkey.pem"
		fi

		# 证书自动续期(90 天),续期后重启服务
		cat > /etc/systemd/system/mail-gateway-renew.service <<'EOF'
[Unit]
Description=Renew Let's Encrypt certs for mail-gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "setfacl -R -m u:mailgate:rX /etc/letsencrypt/live /etc/letsencrypt/archive && systemctl restart mail-gateway"
EOF
		cat > /etc/systemd/system/mail-gateway-renew.timer <<'EOF'
[Unit]
Description=Twice-daily cert renewal check

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
EOF
		systemctl daemon-reload
		systemctl enable --now mail-gateway-renew.timer >/dev/null 2>&1
		echo "✅ 自动续期 timer 已启用(每天 00:00 / 12:00 检查)"
	else
		echo "⚠️ 证书签发失败,请检查 TLS_DOMAIN 的 DNS 是否已指向本机(Cloudflare 代理需关闭)"
	fi
elif [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]]; then
	echo "✅ 使用已有证书:$TLS_CERT"
else
	echo "⚠️ 未配置 TLS(IMAP 将以明文运行,仅限调试;生产请配置 TLS_DOMAIN+CF_DNS_API_TOKEN 自动签发,或用 certbot 手动签发)"
fi

# ---------- 6. 启动 ----------
echo "🚀 启动服务 ..."
systemctl restart $SERVICE_NAME
sleep 2

if systemctl is-active --quiet $SERVICE_NAME; then
	echo ""
	echo "✅ 部署完成!服务状态:"
	systemctl status $SERVICE_NAME --no-pager | head -8
	echo ""
	echo "📋 后续步骤:"
	echo "  1. 配置 TLS 证书(IMAP 993 必须):见 README.md「TLS 证书」章节"
	echo "  2. 验证:openssl s_client -connect <VPS_IP>:$IMAP_PORT -starttls imap(如有 TLS)"
	echo "     或 python3 test/test-imap.py(连本机验证协议)"
	echo "  3. 查看日志:journalctl -u $SERVICE_NAME -f"
else
	echo "❌ 服务启动失败!日志:"
	journalctl -u $SERVICE_NAME --no-pager -n 30
	exit 1
fi
