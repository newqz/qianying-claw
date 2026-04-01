/**
 * 千影Claw 核心桥接层
 * 
 * 连接飞书适配器、Claude Code 运行器和工具同步
 */

import { ClaudeRunner, type ClaudeMessage } from './claude/runner.js';
import { FeishuAdapter, type FeishuMessageEvent } from './feishu/adapter.js';
import { FeishuRenderer } from './feishu/renderer.js';
import { ToolSync } from './tools/sync.js';
import { SubAgentManager } from './tools/subagent.js';
import type { FeishuCardData } from './feishu/renderer.js';
import type { RunnerOptions } from './claude/runner.js';

// 配置接口
export interface QianyingClawConfig {
  // Claude Code 配置
  claude: {
    permissionMode: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
    model?: string;
    workDir?: string;
    additionalDirs?: string[];
  };
  // 飞书配置（仅开发测试用）
  feishu?: {
    appId?: string;
    appSecret?: string;
  };
}

// 消息处理回调
export interface MessageCallbacks {
  sendText?: (openId: string, text: string) => Promise<void>;
  sendCard?: (openId: string, card: FeishuCardData) => Promise<string>;
  updateCard?: (openId: string, messageId: string, card: FeishuCardData) => Promise<void>;
}

export class QianyingClawBridge {
  private runner: ClaudeRunner;
  private adapter: FeishuAdapter;
  private renderer: FeishuRenderer;
  private toolSync: ToolSync;
  private subAgentManager: SubAgentManager;
  private callbacks: MessageCallbacks = {};
  private config: QianyingClawConfig;

  constructor(config: QianyingClawConfig) {
    this.config = config;
    
    // 初始化组件
    this.runner = new ClaudeRunner({
      permissionMode: config.claude.permissionMode,
      model: config.claude.model,
      additionalDirs: config.claude.additionalDirs,
    });

    this.adapter = new FeishuAdapter();
    this.renderer = new FeishuRenderer();
    this.toolSync = new ToolSync();
    this.subAgentManager = new SubAgentManager();

    // 设置回调
    this.setupCallbacks();
    this.setupEventHandlers();
  }

  /**
   * 设置消息回调
   */
  setCallbacks(callbacks: MessageCallbacks): void {
    this.callbacks = callbacks;

    // 同步到工具同步器
    this.toolSync.setCallbacks({
      sendCard: async (card) => {
        // 需要从事件中获取 openId，这里用占位
        return 'temp-message-id';
      },
    });

    // 同步到子Agent管理器
    this.subAgentManager.setCallbacks({
      sendCard: async (card) => {
        return 'temp-message-id';
      },
    });
  }

  /**
   * 设置内部回调
   */
  private setupCallbacks(): void {
    // 工具同步器回调
    this.toolSync.setCallbacks({
      onToolStart: async (call) => {
        console.log(`[Tool] Started: ${call.tool}`);
      },
      onToolResult: async (call) => {
        console.log(`[Tool] Completed: ${call.tool} in ${this.toolSync.getCallDuration(call)}ms`);
      },
      onToolError: async (call, error) => {
        console.error(`[Tool] Failed: ${call.tool}`, error);
      },
      onPermissionRequest: async (call) => {
        console.log(`[Permission] Requested: ${call.tool}`);
      },
    });

    // 子Agent管理器回调
    this.subAgentManager.setCallbacks({
      onToolResult: async (result) => {
        // result 来自 toolSync
      },
    });
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // Claude Code 事件
    this.runner.on('sessionCreated', ({ session }) => {
      console.log(`[Session] Created: ${session.id}`);
    });

    this.runner.on('sessionClosed', ({ sessionId, code }) => {
      console.log(`[Session] Closed: ${sessionId}, code: ${code}`);
    });

    this.runner.on('message', (msg: ClaudeMessage) => {
      this.handleClaudeMessage(msg);
    });

    this.runner.on('toolUse', async (msg: ClaudeMessage) => {
      await this.toolSync.handleToolUse(msg);
    });

    this.runner.on('toolResult', async (msg: ClaudeMessage) => {
      await this.toolSync.handleToolResult(msg);
    });

    this.runner.on('error', async (msg: ClaudeMessage) => {
      await this.toolSync.handleError(msg);
    });

    this.runner.on('permission', async (msg: ClaudeMessage) => {
      await this.toolSync.handlePermission(msg);
    });

    this.runner.on('stdout', ({ sessionId, text }) => {
      console.log(`[stdout:${sessionId}]`, text);
    });
  }

  /**
   * 处理 Claude Code 消息
   */
  private handleClaudeMessage(msg: ClaudeMessage): void {
    switch (msg.type) {
      case 'assistant':
        // 助手回复，转发给飞书
        this.callbacks.sendText?.('unknown', msg.content);
        break;
        
      case 'user':
        console.log(`[User] ${msg.content}`);
        break;
        
      default:
        console.log(`[Message] ${msg.type}:`, msg.content);
    }
  }

  /**
   * 处理飞书消息
   */
  async handleFeishuMessage(event: FeishuMessageEvent): Promise<void> {
    const openId = this.adapter.getSenderOpenId(event);
    const text = this.adapter.extractText(event);

    if (!text.trim()) return;

    // 获取或创建 Claude Session
    let sessionId = this.adapter.getSession(openId);
    
    if (!sessionId) {
      // 创建新会话
      const session = await this.runner.createSession(
        this.config.claude.workDir || '/tmp'
      );
      sessionId = session.id;
      this.adapter.createSession(openId, sessionId);
      
      this.callbacks.sendText?.(openId, '🏮 千影Claw 已启动，请稍候...');
    }

    // 发送消息到 Claude Code
    await this.runner.sendMessage(sessionId, text);
  }

  /**
   * 响应权限请求
   */
  async respondToPermission(sessionId: string, approved: boolean): Promise<void> {
    await this.runner.respondToPermission(sessionId, approved);
  }

  /**
   * 创建新会话
   */
  async createSession(workDir?: string): Promise<string> {
    const session = await this.runner.createSession(workDir || this.config.claude.workDir || '/tmp');
    return session.id;
  }

  /**
   * 关闭会话
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.runner.closeSession(sessionId);
  }

  /**
   * 获取会话状态
   */
  getSessionStatus(sessionId: string): string {
    const session = this.runner.getSession(sessionId);
    if (!session) return 'not_found';
    return session.status;
  }

  /**
   * 获取工具同步状态
   */
  getToolSyncStatus(): string {
    const calls = this.toolSync.getActiveCalls();
    if (calls.length === 0) return '空闲';
    
    return calls.map(c => this.toolSync.formatCallStatus(c)).join(', ');
  }

  /**
   * 获取子Agent状态
   */
  getSubAgentStatus(sessionId?: string): string {
    if (sessionId) {
      return this.subAgentManager.getTaskSummary(sessionId);
    }
    
    const active = this.subAgentManager.getActiveTasks();
    return `${active.length} 个活跃子Agent任务`;
  }

  /**
   * 关闭所有会话
   */
  async shutdown(): Promise<void> {
    console.log('[Bridge] Shutting down...');
    await this.runner.closeAll();
    this.subAgentManager.cleanup(0); // 立即清理
  }
}

// 导出工厂函数
export function createBridge(config: QianyingClawConfig): QianyingClawBridge {
  return new QianyingClawBridge(config);
}
