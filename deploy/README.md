# BlotLens 公网试运行部署

当前面向 Ubuntu 24.04 x86_64、Node 24、Caddy 反向代理。独立项目和本机工作台仍可沿用 `npm run dev`，不设置公网环境变量。

## 公网数据处理

- 灰度测量、编辑和导出在浏览器执行。只有用户点击识别才发送所选图像。
- 公网模式：密钥仅存当前页面内存，识别请求通过本站 HTTPS 服务转发至用户选定的视觉服务。密钥和截图不会持久化到服务器、日志、浏览器存储或分析文件。页面刷新清除配置。模型供应商按其自身政策处理请求。
- 不接受共享 POST `/api/config`；每个 `/api/recognize` 请求独立携带自己的 provider 配置，避免不同用户共享密钥。
- 后端仅监听 127.0.0.1，验证准确 Host/Origin。Caddy 必须覆盖 `X-Real-IP`。不能直接暴露 4317 端口。
- HTTPS 服务地址采取运营者维护的精确允许列表，不允许访问者配置任意中转站；不跟随 HTTP 重定向。添加域名前需核实服务所有权、公网解析和固定路径，不添加用户控制的 DNS、私网端点或通用转发服务。自定义任意地址功能仍在本机版提供。
- 默认全局最多 4 个读取/识别请求，同 IP 最多 2 个并发、5 分钟 10 次；内存限流不是 DDoS 防护。上传 24 MiB、模型响应 2 MiB、识别 90 秒上限。断开或超时终止上游，不自动重试付费调用。
- 不启用 Caddy access/debug 日志、请求正文日志、分析追踪或云端文件保存。systemd 禁止 core dump，服务为无登录权限用户，文件系统只读。IP 限流计数仅短期保留在内存。
- API 兼容性与视觉支持取决于用户选择的模型，地址在列表中不代表该服务的每个模型支持图片。尚未以真实用户密钥验证任何供应商。

## 构建与安装（先不公开服务）

```sh
npm ci
npm run check
BROWSER_CHANNEL=msedge npm run test:e2e
npm run package:release
```

发布 `.release/blotlens-linux.tar.gz` 和 SHA256 校验文件。安装包包含已构建前端和单文件 Node 服务，服务器不需要 npm 或构建工具，也不含截图或密钥。

服务器解压已核验的安装包后执行：

```sh
sudo bash /path/to/package/deploy/install-ubuntu.sh /path/to/package
```

安装脚本仅适用于新服务器；检测到非本项目 Caddy 配置时会停止。安装 Ubuntu 仓库 Caddy、经过官方 SHA256 验证的 Node 24.14.1，在 `/opt/blotlens/releases` 放置版本，通过 `/opt/blotlens/current` 选择当前版本。只启动 loopback 应用，暂不公开 HTTP/HTTPS。

## 域名、HTTPS 和正式开放

1. 将 `blotlens.top` 和 `www.blotlens.top` 的 A 记录指向服务器公网 IPv4；不填写内网地址。检查并清理冲突记录，不修改另一个域名。
2. 在阿里云防火墙只开放网站所需 TCP 80/443；保留已有管理连接，不开放 4317。若启用了 UFW，同样配置，但不要意外阻断 SSH。
3. 在用户同意网站公开和 Let's Encrypt 订户协议后激活：

```sh
sudo install -m 644 /etc/caddy/Caddyfile.blotlens-ready /etc/caddy/Caddyfile
sudo systemctl unmask caddy
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy 自动获取和续期 HTTPS 证书；HTTP 自动跳转 HTTPS，www 跳转主域。域名和证书记录公开。安装使用单一 Let's Encrypt CA，不切换其他 CA。另一个网站后续新增 Caddy site block，共享服务器。

验收：HTTPS 证书可信、GET `/api/config` 返回 hosted=true 且无密钥、POST `/api/config` 被拒绝、陌生 Origin 被拒绝、合成示例测量和导出可用、刷新丢弃 Key。真实 API 验证需用户主动提供其服务配置，不从旧本机设置复制。

配置变更：`/etc/blotlens.env` 可设置 `BLOTLENS_PROVIDERS`（逗号分隔精确 HTTPS Base URL），然后 `systemctl restart blotlens`；此文件不用于保存用户 API Key。

## 更新、回滚与检查

- 每次安装保留版本目录；旧版本地址写入 `/opt/blotlens/previous-release`。回滚时将 current 链接指向该目录并重启 blotlens。
- `systemctl status blotlens caddy` 检查服务；`journalctl -u blotlens -u caddy` 只看运行状态，严禁增设正文/密钥日志。
- 定期更新 Node、Ubuntu/Caddy 安全修复及应用依赖，并检查证书续期和磁盘占用。
- 试运行不保存用户分析文件，无数据库。用户自行导出备份；自动部署不会把本机已有截图或 API Key 上传服务器。
