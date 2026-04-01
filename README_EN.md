# QianyingClaw

> Feishu AI Programming Assistant - Powered by Claude Code + MiniMax

## 🎯 Goal

Interactive AI programming through Feishu/Lark with full Claude Code capabilities:

- 💬 Feishu conversation
- 💻 Claude Code tools (file read/write, terminal commands)
- 🤖 Sub-agent parallel tasks
- 🔧 Tool execution feedback
- ⚡ MiniMax model

## 🚀 Quick Start

```bash
git clone https://github.com/your-org/qianying-claw.git
cd qianying-claw
npm install
npm start
```

## 📡 API

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:18792/ws?openId=user_123');
ws.send(JSON.stringify({ type: 'message', content: 'Write a sorting algorithm' }));
```

## 📜 License

MIT
