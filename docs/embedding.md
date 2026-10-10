# 同源嵌入协议 v1

BlotLens 可独立运行，也可由 WB 工作台在同源 iframe 中加载。工作台通过 Git 子模块固定版本，复用识别、测量和交互代码。模块保持挂载时，切回其他流程不会清空分析。刷新或关闭前仍需导出分析 JSON。

子页面准备好后发送 `{type: "blotlens:ready", version: 1}`。父页面可发送 `{type: "blotlens:import-image", version: 1, requestId, name, mimeType, bytes}`，其中 bytes 为 1 字节至 15 MiB 的 ArrayBuffer，mimeType 只允许 image/png 或 image/jpeg。

子页面同时校验消息的 origin 和 source，只接受同源直接父窗口。图片使用独立应用的解码、尺寸和哈希检查；接收后返回 `{type: "blotlens:import-result", version: 1, requestId, ok}`。导入只加载草稿，绝不自动调用模型。

宿主可复用 `server/start.ts` 的 `startLocalApp` 提供同源 API，密钥只在当前本机服务的内存中保留。静态页面支持人工分析和导出；AI 识别需要本机 Node 服务。不放宽 CORS，不自动切换供应商。

截图分析文件和工作台实验项目包保留各自格式；截图估计不得自动混入实验重复统计。
