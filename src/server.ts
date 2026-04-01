/**
 * 千影Claw Gateway - 常驻后台服务
 * 
 * 功能：
 * - 进程管理（Claude Code CLI）
 * - WebSocket 服务器（接收飞书消息）
 * - 会话管理（多用户）
 * - 健康检查
 * - 日志记录
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClaudeRunner, type ClaudeSession } from './claude/runner.js';
import { QianyingClawBridge, type QianyingClawConfig } from './bridge.js';
import { renderer } from './feishu/renderer.js';
import { toolSync } from './tools/sync.js';
import { subAgentManager } from './tools/subagent.js';
import { v4 as uuidv4 } from 'uuid';

// 日志级别
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  sessions: {
    total: number;
    active: number;
  };
  tools: {
    active: number;
    pending: number;
  };
  memory: {
    rss: number;
    heapUsed: number;
  };
}

export class QianyingClawGateway {
  private port: number;
  private host: string;
  private server: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private bridge: QianyingClawBridge | null = null;
  private runner: ClaudeRunner;
  private startTime: Date;
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;
  
  // WebSocket 连接管理
  private connections: Map<string, {
    ws: WebSocket;
    openId?: string;
    sessionId?: string;
    connectedAt: Date;
  }> = new Map();

  // 会话管理
  private sessions: Map<string, {
    openId: string;
    claudeSessionId: string;
    createdAt: Date;
    lastActivity: Date;
    status: 'idle' | 'busy' | 'waiting_permission';
  }> = new Map();

  constructor(port: number = 18792, host: string = '0.0.0.0') {
    this.port = port;
    this.host = host;
    this.startTime = new Date();
    this.runner = new ClaudeRunner();
  }

  /**
   * 初始化
   */
  async init(config: QianyingClawConfig): Promise<void> {
    this.log('info', 'Initializing QianyingClaw Gateway...');
    
    // 创建 Bridge
    this.bridge = new QianyingClawBridge(config);
    
    // 设置 Bridge 回调
    this.bridge.setCallbacks({
      sendText: async (openId, text) => {
        await this.sendToUser(openId, { type: 'text', content: text });
      },
      sendCard: async (openId, card) => {
        return await this.sendCardToUser(openId, card);
      },
      updateCard: async (openId, messageId, card) => {
        await this.updateCardForUser(openId, messageId, card);
      },
    });

    // 设置工具同步回调
    toolSync.setCallbacks({
      onToolStart: async (call) => {
        this.log('debug', `Tool started: ${call.tool}`);
        await this.broadcastToUser(call.sessionId, {
          type: 'tool_start',
          tool: call.tool,
          input: call.input,
        });
      },
      onToolResult: async (call) => {
        this.log('debug', `Tool completed: ${call.tool} in ${toolSync.getCallDuration(call)}ms`);
        await this.broadcastToUser(call.sessionId, {
          type: 'tool_result',
          tool: call.tool,
          result: call.result,
          duration: toolSync.getCallDuration(call),
        });
      },
      onPermissionRequest: async (call) => {
        this.log('info', `Permission requested: ${call.tool}`);
        await this.broadcastToUser(call.sessionId, {
          type: 'permission_request',
          tool: call.tool,
          input: call.input,
        });
      },
    });

    this.log('info', 'Gateway initialized');
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 创建 HTTP 服务器
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleHttpRequest(req, res);
      });

      // 创建 WebSocket 服务器
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleWebSocketConnection(ws, req);
      });

      this.wss.on('error', (error: Error) => {
        this.log('error', 'WebSocket server error', error);
      });

      // 启动监听
      this.server.listen(this.port, this.host, () => {
        this.log('info', `Gateway listening on ${this.host}:${this.port}`);
        resolve();
      });

      this.server.on('error', (error: Error) => {
        this.log('error', 'Server error', error);
        reject(error);
      });
    });
  }

  /**
   * 处理 HTTP 请求
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    
    // CORS 预检
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = url.pathname;

    try {
      switch (path) {
        case '/health':
          this.handleHealth(res);
          break;
        case '/status':
          this.handleStatus(res);
          break;
        case '/logs':
          this.handleLogs(res, url);
          break;
        case '/sessions':
          this.handleSessions(res);
          break;
        case '/metrics':
          this.handleMetrics(res);
          break;
        default:
          if (path.startsWith('/ws/')) {
            // WebSocket 升级请求处理
            res.writeHead(426, { 'Upgrade': 'websocket' });
            res.end();
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
      }
    } catch (error) {
      this.log('error', 'HTTP handler error', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * 健康检查
   */
  private handleHealth(res: ServerResponse): void {
    const health = this.getHealth();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  }

  /**
   * 状态概览
   */
  private handleStatus(res: ServerResponse): void {
    const sessions = Array.from(this.sessions.values());
    const tools = toolSync.getActiveCalls();
    const subAgents = subAgentManager.getActiveTasks();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'QianyingClaw Gateway',
      version: '1.0.0',
      uptime: Date.now() - this.startTime.getTime(),
      startTime: this.startTime.toISOString(),
      sessions: {
        total: sessions.length,
        active: sessions.filter(s => s.status !== 'idle').length,
        list: sessions.map(s => ({
          openId: s.openId,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          lastActivity: s.lastActivity.toISOString(),
        })),
      },
      tools: {
        active: tools.length,
        pending: tools.filter(t => t.status === 'pending').length,
      },
      subAgents: {
        active: subAgents.length,
      },
      connections: this.connections.size,
    }, null, 2));
  }

  /**
   * 日志
   */
  private handleLogs(res: ServerResponse, url: URL): void {
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const level = url.searchParams.get('level') as LogLevel | null;
    
    let logs = this.logs;
    if (level) {
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
      const minLevel = levels.indexOf(level);
      logs = logs.filter(l => levels.indexOf(l.level) >= minLevel);
    }
    
    const tail = logs.slice(-limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: tail, total: this.logs.length }));
  }

  /**
   * 会话列表
   */
  private handleSessions(res: ServerResponse): void {
    const sessions = Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      ...s,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  }

  /**
   * 指标
   */
  private handleMetrics(res: ServerResponse): void {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`
# HELP qianying_claw_uptime_seconds Gateway uptime in seconds
# TYPE qianying_claw_uptime_seconds gauge
qianying_claw_uptime_seconds ${Math.floor((Date.now() - this.startTime.getTime()) / 1000)}

# HELP qianying_claw_sessions_total Total number of sessions
# TYPE qianying_claw_sessions_total gauge
qianying_claw_sessions_total ${this.sessions.size}

# HELP qianying_claw_connections_total Total WebSocket connections
# TYPE qianying_claw_connections_total gauge
qianying_claw_connections_total ${this.connections.size}

# HELP qianying_claw_tools_active Active tool calls
# TYPE qianying_claw_tools_active gauge
qianying_claw_tools_active ${toolSync.getActiveCalls().length}

# HELP qianying_claw_memory_bytes Memory usage
# TYPE qianying_claw_memory_bytes gauge
qianying_claw_memory_bytes{type="rss"} ${mem.rss}
qianying_claw_memory_bytes{type="heapUsed"} ${mem.heapUsed}
`.trim());
  }

  /**
   * 处理 WebSocket 连接
   */
  private handleWebSocketConnection(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = uuidv4();
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const openId = url.searchParams.get('openId') || 'anonymous';

    this.connections.set(connectionId, {
      ws,
      openId,
      connectedAt: new Date(),
    });

    this.log('info', `WebSocket connected: ${connectionId} (openId: ${openId})`);

    // 发送欢迎消息
    ws.send(JSON.stringify({
      type: 'connected',
      connectionId,
      message: '🏮 千影Claw Gateway 已连接',
    }));

    // 处理消息
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleWebSocketMessage(connectionId, message);
      } catch (error) {
        this.log('error', 'WebSocket message parse error', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    // 处理关闭
    ws.on('close', () => {
      this.log('info', `WebSocket disconnected: ${connectionId}`);
      this.connections.delete(connectionId);
    });

    // 处理错误
    ws.on('error', (error: Error) => {
      this.log('error', `WebSocket error: ${connectionId}`, error);
    });
  }

  /**
   * 处理 WebSocket 消息
   */
  private async handleWebSocketMessage(connectionId: string, message: Record<string, unknown>): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    const { type } = message;

    switch (type) {
      case 'auth':
        // 认证
        conn.openId = message.openId as string;
        conn.ws.send(JSON.stringify({ type: 'auth_ok', openId: conn.openId }));
        break;

      case 'message':
        // 用户消息
        await this.handleUserMessage(conn, message.content as string);
        break;

      case 'permission_response':
        // 权限响应
        const { sessionId, approved } = message;
        if (sessionId && typeof approved === 'boolean') {
          await this.bridge?.respondToPermission(sessionId as string, approved);
        }
        break;

      case 'ping':
        conn.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      default:
        this.log('warn', `Unknown message type: ${type}`);
    }
  }

  /**
   * 处理用户消息
   */
  private async handleUserMessage(conn: typeof this.connections extends Map<string, infer V> ? V : never, content: string): Promise<void> {
    const openId = conn.openId || 'anonymous';
    
    // 获取或创建会话
    let session = this.findSessionByOpenId(openId);
    
    if (!session) {
      // 创建新 Claude 会话
      const claudeSession = await this.runner.createSession('/tmp');
      session = {
        openId,
        claudeSessionId: claudeSession.id,
        createdAt: new Date(),
        lastActivity: new Date(),
        status: 'idle',
      };
      this.sessions.set(claudeSession.id, session);
      conn.sessionId = claudeSession.id;
      
      this.log('info', `New session created for ${openId}: ${claudeSession.id}`);
      
      // 发送初始消息
      conn.ws.send(JSON.stringify({
        type: 'session_created',
        sessionId: claudeSession.id,
        message: '🏮 千影Claw 已启动，请稍候...',
      }));
    }

    // 更新活跃时间
    session.lastActivity = new Date();
    session.status = 'busy';

    // 发送消息到 Claude Code
    try {
      await this.runner.sendMessage(session.claudeSessionId, content);
    } catch (error) {
      this.log('error', `Failed to send message to Claude`, error);
      conn.ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process message',
      }));
    }

    // 更新状态
    session.status = 'idle';
  }

  /**
   * 查找用户的会话
   */
  private findSessionByOpenId(openId: string): typeof this.sessions extends Map<string, infer V> ? V : never | undefined {
    for (const session of this.sessions.values()) {
      if (session.openId === openId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * 发送文本给用户
   */
  private async sendToUser(openId: string, data: { type: string; content: string }): Promise<void> {
    for (const conn of this.connections.values()) {
      if (conn.openId === openId) {
        conn.ws.send(JSON.stringify(data));
        break;
      }
    }
  }

  /**
   * 发送卡片给用户
   */
  private async sendCardToUser(openId: string, card: ReturnType<typeof renderer.renderToolUse>): Promise<string> {
    const messageId = uuidv4();
    for (const conn of this.connections.values()) {
      if (conn.openId === openId) {
        conn.ws.send(JSON.stringify({
          type: 'card',
          messageId,
          card,
        }));
        break;
      }
    }
    return messageId;
  }

  /**
   * 更新卡片
   */
  private async updateCardForUser(openId: string, messageId: string, card: ReturnType<typeof renderer.renderToolUse>): Promise<void> {
    for (const conn of this.connections.values()) {
      if (conn.openId === openId) {
        conn.ws.send(JSON.stringify({
          type: 'card_update',
          messageId,
          card,
        }));
        break;
      }
    }
  }

  /**
   * 广播到用户会话
   */
  private async broadcastToUser(sessionId: string, data: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const conn of this.connections.values()) {
      if (conn.sessionId === sessionId || conn.openId === session.openId) {
        conn.ws.send(JSON.stringify(data));
      }
    }
  }

  /**
   * 获取健康状态
   */
  private getHealth(): HealthStatus {
    const mem = process.memoryUsage();
    const sessions = Array.from(this.sessions.values());
    const tools = toolSync.getActiveCalls();

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    // 检查内存
    if (mem.heapUsed > 500 * 1024 * 1024) { // 500MB
      status = 'degraded';
    }
    if (mem.heapUsed > 1000 * 1024 * 1024) { // 1GB
      status = 'unhealthy';
    }

    // 检查活跃会话
    if (sessions.length > 100) {
      status = 'degraded';
    }

    return {
      status,
      uptime: Date.now() - this.startTime.getTime(),
      sessions: {
        total: sessions.length,
        active: sessions.filter(s => s.status !== 'idle').length,
      },
      tools: {
        active: tools.length,
        pending: tools.filter(t => t.status === 'pending').length,
      },
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
      },
    };
  }

  /**
   * 日志记录
   */
  private log(level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };
    
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'debug' ? '🔍' : 'ℹ️';
    console.log(`${prefix} [${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    this.log('info', 'Shutting down Gateway...');

    // 关闭所有 Claude 会话
    await this.runner.closeAll();

    // 关闭 WebSocket
    for (const conn of this.connections.values()) {
      conn.ws.close();
    }
    this.connections.clear();

    // 关闭 WebSocket 服务器
    this.wss?.close();

    // 关闭 HTTP 服务器
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.log('info', 'Gateway stopped');
  }
}
