/**
 * 千影Claw 入口
 * 
 * 用法：
 *   npm run dev          - 开发模式
 *   npm start            - 启动 Gateway
 *   npm run stop         - 停止 Gateway
 *   npm run status       - 查看状态
 *   npm run health       - 健康检查
 */

import { QianyingClawGateway } from './server.js';
import { QianyingClawConfig } from './bridge.js';

// 全权限配置
const DEFAULT_CONFIG: QianyingClawConfig = {
  claude: {
    permissionMode: 'bypassPermissions',  // 全系统权限
    model: 'MiniMax-M2.7-highspeed',  // MiniMax M2.7 高速版
    workDir: '/root',  // 从 root 目录开始
    additionalDirs: ['/home', '/tmp', '/var'],  // 允许访问更多目录
  },
};

let gateway: QianyingClawGateway | null = null;

/**
 * 启动 Gateway
 */
async function start(port?: number): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         🏮 千影Claw Gateway 🏮                   ║
╚═══════════════════════════════════════════════════╝
  `);

  const gatewayPort = port || parseInt(process.env.QIANYING_PORT || '18792');

  gateway = new QianyingClawGateway(gatewayPort);
  
  try {
    await gateway.init(DEFAULT_CONFIG);
    await gateway.start();
    
    console.log(`
✅ Gateway 已启动

📡 端口: ${gatewayPort}
🌐 地址: http://0.0.0.0:${gatewayPort}

📋 API 端点:
   GET /health      - 健康检查
   GET /status      - 状态概览
   GET /sessions    - 会话列表
   GET /logs        - 日志
   GET /metrics     - Prometheus 指标

🔌 WebSocket: ws://localhost:${gatewayPort}?openId=<用户ID>

按 Ctrl+C 停止
`);
  } catch (error) {
    console.error('❌ 启动失败:', error);
    process.exit(1);
  }
}

/**
 * 停止 Gateway
 */
async function stop(): Promise<void> {
  if (gateway) {
    await gateway.stop();
    gateway = null;
    console.log('✅ Gateway 已停止');
  } else {
    console.log('Gateway 未运行');
  }
}

/**
 * 查看状态
 */
async function status(): Promise<void> {
  try {
    const response = await fetch('http://localhost:18792/status');
    const data = await response.json();
    
    console.log(`
╔═══════════════════════════════════════════════════╗
║         🏮 千影Claw Gateway 状态                  ║
╚═══════════════════════════════════════════════════╝

📦 版本: ${data.version}
⏱️  运行时间: ${formatUptime(data.uptime)}
📅 启动时间: ${data.startTime}

👥 会话:
   总数: ${data.sessions.total}
   活跃: ${data.sessions.active}

🔧 工具:
   活跃: ${data.tools.active}
   等待中: ${data.tools.pending}

🤖 子Agent:
   活跃: ${data.subAgents.active}

🔗 连接: ${data.connections}
`);
  } catch (error) {
    console.log('❌ Gateway 未运行或无法连接');
    process.exit(1);
  }
}

/**
 * 健康检查
 */
async function health(): Promise<void> {
  try {
    const response = await fetch('http://localhost:18792/health');
    const data = await response.json();
    
    const icon = data.status === 'healthy' ? '✅' : data.status === 'degraded' ? '⚠️' : '❌';
    
    console.log(`
${icon} 健康状态: ${data.status.toUpperCase()}

⏱️  运行时间: ${formatUptime(data.uptime)}

👥 会话: ${data.sessions.active} / ${data.sessions.total} 活跃
🔧 工具: ${data.tools.pending} 等待中, ${data.tools.active} 活跃

💾 内存:
   RSS: ${formatBytes(data.memory.rss)}
   Heap: ${formatBytes(data.memory.heapUsed)}
`);
  } catch (error) {
    console.log('❌ Gateway 未运行或无法连接');
    process.exit(1);
  }
}

/**
 * 格式化运行时间
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}天 ${hours % 24}小时`;
  if (hours > 0) return `${hours}小时 ${minutes % 60}分钟`;
  if (minutes > 0) return `${minutes}分钟 ${seconds % 60}秒`;
  return `${seconds}秒`;
}

/**
 * 格式化字节
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// 信号处理
process.on('SIGINT', async () => {
  console.log('\n\n🛑 收到停止信号...');
  await stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await stop();
  process.exit(0);
});

// 主函数
async function main(): Promise<void> {
  const command = process.argv[2] || 'start';
  const port = process.argv[3] ? parseInt(process.argv[3]) : undefined;

  switch (command) {
    case 'start':
      await start(port);
      break;
    case 'stop':
      await stop();
      break;
    case 'status':
      await status();
      break;
    case 'health':
      await health();
      break;
    case 'restart':
      await stop();
      await new Promise(r => setTimeout(r, 1000));
      await start(port);
      break;
    default:
      console.log(`
🏮 千影Claw Gateway

用法:
   npm start           启动 Gateway (默认端口 18792)
   npm run start -- 18800   启动并指定端口
   npm run stop       停止 Gateway
   npm run status     查看状态
   npm run health     健康检查
   npm run restart    重启 Gateway
      `);
      process.exit(1);
  }
}

main().catch(console.error);
