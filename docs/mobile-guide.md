# Shoal 手机端远程连接与锁屏通知配置指南

Shoal 采用**「用户完全自托管（Bring Your Own Tunnel / Webhook）」**架构：开源仓库与安装包不包含任何官方中转服务器或第三方凭证，所有令牌、设备哈希与 Webhook 密钥仅保存在你本机 `<stateDir>/mobile.json` 中，权限严格限制在隔离移动网关端口（默认 `47801`，桌面主管理端 `47800` 不暴露至公网）。

---

## 一、三种网络接入方式（按场景三选一）

先点击 Shoal 桌面端右上角 **「手机遥控」**，打开「开启手机远程网关」。

### 1. 同 Wi-Fi 局域网直连（零配置）

适合在家或办公室同一局域网使用，无需安装任何额外工具：

1. 勾选「允许同局域网 Wi-Fi 访问」；
2. 点击「发起扫码配对」，用手机浏览器扫局域网二维码；
3. 在电脑端输入手机屏幕显示的 **6 位确认码**，即可完成绑定。

### 2. 出门外网：Cloudflare 临时隧道（免账号、零域名推荐体验）

只需本机装有 `cloudflared`，**无需注册 Cloudflare 账号，也无需购买域名**，10 秒生成公网加密 HTTPS 入口：

1. 安装 `cloudflared`（Windows PowerShell 执行后重启 Shoal）：
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
2. 在「手机遥控 → 出门公网」选择 **「免账号临时隧道（trycloudflare）」**；
3. 勾选「启动免注册临时公网隧道」，等待 3–5 秒状态变为「已连通」，自动生成 `https://*.trycloudflare.com` 地址；
4. 下方「发起扫码配对」会自动多出一个「Cloudflare 临时隧道」二维码标签页，扫码即可出门遥控。

> 提示：临时隧道每次重启桌面端或重开隧道开关都会分配新的随机域名，适合临时出门或体验；若希望在手机主屏幕固定书签长期使用，建议选用下方的自定义域名隧道。

### 3. 长期固定外网：Cloudflare Named Tunnel（或 Tailscale Serve）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Tunnels** → **Create a tunnel（cloudflared）**；
2. 安装器步骤完成后，只复制命令末尾的 `eyJ...` Tunnel Token，粘贴到 Shoal 弹窗中的 **「Tunnel Token」** 输入框（Shoal 通过环境变量注入子进程，不暴露在命令行参数中）；
3. 在 Cloudflare **Published Application Routes** 添加公网域名：
   - **Subdomain / Domain**：填你的子域名（如 `shoal.yourdomain.com`）
   - **Service URL**：**务必填写 `http://127.0.0.1:47801`（移动隔离网关端口）**，**严禁指向 `47800` 桌面管理端口**；
4. 回到 Shoal 选择 **「固定域名 / 外部 HTTPS」**，填入 `https://shoal.yourdomain.com`、勾选自动启动隧道并保存。

#### 可选第二道防线：Cloudflare Zero Trust 邮箱白名单

- 若已在 Cloudflare 启用 Zero Trust Free 计划，可在 **Access → Applications** 新增 Self-hosted 应用保护你的 `shoal.yourdomain.com`，策略设为允许指定邮箱（Allow Emails）；
- 在 Cloudflare 应用详情页复制 **Application AUD**，连同 Team Domain（`<team>.cloudflareaccess.com`）一起填入 Shoal 弹窗的「可选第二道防线」折叠栏，Shoal 服务端会自动拉取 JWKS 公钥校验边缘 `CF-Access-Jwt-Assertion` `RS256` 签名。

#### 备选方案：Tailscale Serve

若你已在电脑和手机运行 Tailscale，可选择 **「固定域名 / 外部 HTTPS」**、关闭 `cloudflared` 自动启动开关，由本机执行：

```sh
tailscale serve --bg http://127.0.0.1:47801
```

随后把生成的 `https://<machine>.<tailnet>.ts.net` 填入「公网访问域名 Origin」并保存，Shoal 的 `Host` / `Origin` 白名单和二维码生成会自动适配。

---

## 二、手机锁屏提醒（多平台 Webhook 自动识别）

Shoal 会自动根据你填入的 Webhook URL 识别推送平台，**推送内容严格脱敏**（仅包含项目名、单行任务标题、等待状态与任务深链 `#task=<id>`，绝不外发源码、本机路径或回复正文）。

| 平台 | Webhook URL 填写格式 | Secret 密钥栏说明 |
| --- | --- | --- |
| **飞书 / Lark** | `https://open.feishu.cn/open-apis/bot/v2/hook/<token>` 或 `open.larksuite.com/...` | 若机器人启用了「签名校验」，填入密钥；Shoal 自动按官方规范生成 `timestamp + "\n" + secret` HMAC-SHA256 |
| **Discord** | 服务器频道设置的 Webhook：`https://discord.com/api/webhooks/<id>/<token>` | 留空即可 |
| **Slack** | Incoming Webhook：`https://hooks.slack.com/services/...` | 留空即可 |
| **Telegram Bot** | `https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>` | 留空即可（`chat_id` 仅作参数解析，不在界面明文回显 Bot Token） |
| **通用公网 HTTPS** | 任意公网 `https://` Webhook（支持 Bark、自建通知网关等，带私网 IP / DNS 重绑定 SSRF 防护） | 可选；填写后请求头附带 `X-Shoal-Timestamp` 与 `X-Shoal-Signature: sha256=<HMAC-SHA256(secret, ts + "." + body)>` |

建议勾选「最近 60 秒内桌面端有操作时静默推送」，坐在电脑前工作时不会重复刷屏；配置完可直接点 **「发送测试通知」** 验证连通性。

---

## 三、常见问题：开启代理 / TUN 后隧道连不上（端口 7844 拦截）

### 症状

开启隧道后状态停在「正在建链…」，或报错包含：
- `failed to dial to edge with quic: timeout`
- `TLS handshake with edge error: EOF`

### 原因与解决方法

`cloudflared`（已默认使用 HTTP/2 over IPv4）建链时会连接 Cloudflare Argo 边缘节点的 **7844** 端口（`region1.v2.argotunnel.com` / `region2.v2.argotunnel.com`）。许多系统代理（v2rayN、Clash、Mihomo、sing-box）的 TUN 模式或海外中转节点默认只放行 80 / 443 常见网页端口，会切断发往 `7844` 的流量。

请按下面方式为你正在使用的代理客户端放行直连规则：

#### 1. v2rayN（sing-box TUN / Xray 双核）

> 注意：在 v2rayN / sing-box / Xray 中，**同一条路由规则里的多个条件字段属于「逻辑与（AND）」关系**，请勿把进程名、域名、IP 和端口塞进同一条规则，否则永远无法命中。

请在当前激活的路由规则集最顶部添加 **4 条独立的 `direct`（直连）规则**：

| 序号 | OutboundTag | 填写字段 | 填写值 |
| --- | --- | --- | --- |
| 1 | `direct` | 进程（Process） | `cloudflared.exe` |
| 2 | `direct` | 域名（Domain） | `domain:argotunnel.com`, `domain:cftunnel.com`, `domain:trycloudflare.com` |
| 3 | `direct` | IP（Ip） | `198.41.192.0/24`, `198.41.200.0/24`, `2606:4700:a0::/48`, `2606:4700:a8::/48` |
| 4 | `direct` | 端口（Port） | `7844` |

#### 2. Clash / Mihomo / Clash Verge

在自定义规则顶部 `rules:` 追加（须排在最终兜底规则与全球代理规则之前）：

```yaml
rules:
  - PROCESS-NAME,cloudflared.exe,DIRECT
  - DOMAIN-SUFFIX,argotunnel.com,DIRECT
  - DOMAIN-SUFFIX,cftunnel.com,DIRECT
  - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
  - IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
  - IP-CIDR,198.41.200.0/24,DIRECT,no-resolve
  - DST-PORT,7844,DIRECT
```

保存后重载代理内核并重开 Shoal 隧道开关，几秒内即可看到「已连通（4 节点）」。
