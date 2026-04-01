# 千影Claw (QianyingClaw)

> 飞书版 AI 编程助手 — 融合 Claude Code + MiniMax

[English](./README_EN.md)

## 🎯 目标

通过飞书与 Claude Code 互动，获得类似 OpenClaw 的完整体验：

- 💬 飞书对话
- 💻 Claude Code 编程能力（文件读写、终端命令）
- 🤖 子Agent并行任务
- 🔧 工具调用状态反馈
- ⚡ MiniMax 模型驱动

## 🏗️ 架构

```
┌─────────────────┐     ┌─────────────────────────┐     ┌──────────────────┐
│      飞书       │────▶│   QianyingClaw Gateway │────▶│  Claude Code CLI │
│   (消息收发)     │◀────│   (WebSocket + 路由)   │◀────│  (MiniMax 模型) │
└─────────────────┘     └─────────────────────────┘     └──────────────────┘
```

## 🚀 快速开始

### 前置要求

- Node.js >= 18.0.0
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- MiniMax API Key

### 安装

```bash
git clone https://github.com/your-org/qianying-claw.git
cd qianying-claw
npm install
```

### 配置

```bash
# 配置 Claude Code 使用 MiniMax
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-minimax-api-key",
    "ANTHROPIC_MODEL": "MiniMax-M2.7",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
EOF
```

### 运行

```bash
# 开发模式
npm run dev

# 生产模式
npm start

# 查看状态
curl http://localhost:18792/status
```

## 📡 API

### HTTP 端点

| 端点 | 描述 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /status` | 服务状态 |
| `GET /metrics` | Prometheus 指标 |

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:18792/ws?openId=user_123');

ws.on('open', () => {
  // 发送消息
  ws.send(JSON.stringify({ type: 'message', content: '帮我写一个排序算法' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log(msg);
});
```

## 🐳 Docker 部署

```bash
# 构建
docker build -t qianying-claw .

# 运行
docker run -d -p 18792:18792 \
  -v ~/.claude:/root/.claude:ro \
  qianying-claw
```

或使用 docker-compose:

```bash
docker-compose up -d
```

## 📁 项目结构

```
qianying-claw/
├── src/
│   ├── main.ts          # 入口
│   ├── server.ts        # Gateway 服务
│   ├── bridge.ts        # 核心桥接
│   ├── claude/
│   │   └── runner.ts    # Claude Code 进程管理
│   ├── feishu/
│   │   ├── adapter.ts   # 飞书适配
│   │   └── renderer.ts  # 消息渲染
│   └── tools/
│       ├── sync.ts       # 工具同步
│       └── subagent.ts   # 子Agent管理
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

## 🔧 开发

```bash
# 类型检查
npm run build

# 测试
npm test

# 监听模式
npm run dev
```

## 📜 许可证

MIT License

## 🏮 关于

由 [新千竹文化](https://github.com/newqz) 开发维护
