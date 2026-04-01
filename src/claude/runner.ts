/**
 * Claude Code Runner - 管理 Claude Code CLI 进程
 * 
 * 功能：
 * - 启动/停止 Claude Code 进程
 * - 发送消息获取响应
 * - 流式输出处理
 * - 多会话管理
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export interface ClaudeSession {
  id: string;
  process: ChildProcess | null;
  workDir: string;
  createdAt: Date;
  status: 'idle' | 'running' | 'waiting_permission' | 'error';
}

export interface ClaudeMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'error' | 'permission';
  content: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  sessionId: string;
  timestamp: Date;
}

export interface RunnerOptions {
  permissionMode: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
  model?: string;
  additionalDirs?: string[];
  maxConcurrent?: number;
}

const DEFAULT_OPTIONS: RunnerOptions = {
  permissionMode: 'acceptEdits',
  maxConcurrent: 4,
};

export class ClaudeRunner extends EventEmitter {
  private sessions: Map<string, ClaudeSession> = new Map();
  private options: RunnerOptions;
  private outputBuffer: Map<string, string> = new Map();

  constructor(options: Partial<RunnerOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 创建新会话
   */
  async createSession(workDir: string = '/tmp'): Promise<ClaudeSession> {
    const id = uuidv4();
    
    const args = [
      '--print',
      '--permission-mode', this.options.permissionMode,
      '--output-format', 'stream-json',
      '--session-id', id,
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...(this.options.additionalDirs?.length 
        ? ['--add-dir', ...this.options.additionalDirs] 
        : []
      ),
    ];

    const proc = spawn('claude', args, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // MiniMax 配置（如果已设置在 ~/.claude/settings.json，会自动读取）
      },
    });

    const session: ClaudeSession = {
      id,
      process: proc,
      workDir,
      createdAt: new Date(),
      status: 'idle',
    };

    this.sessions.set(id, session);
    this.outputBuffer.set(id, '');

    // 处理输出
    proc.stdout?.on('data', (data: Buffer) => {
      this.handleOutput(id, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.emit('error', { sessionId: id, error: data.toString() });
    });

    proc.on('close', (code) => {
      this.emit('sessionClosed', { sessionId: id, code });
      this.sessions.delete(id);
    });

    this.emit('sessionCreated', { session });
    return session;
  }

  /**
   * 发送消息到会话
   */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.process) {
      throw new Error(`Session ${sessionId} not found or process not running`);
    }

    if (session.process.stdin?.writable) {
      session.status = 'running';
      
      // 构建符合 stream-json 格式的输入
      const input = JSON.stringify({
        type: 'user',
        content: message,
      }) + '\n';
      
      session.process.stdin.write(input);
    }
  }

  /**
   * 处理流式输出
   */
  private handleOutput(sessionId: string, data: string): void {
    this.outputBuffer.set(
      sessionId,
      (this.outputBuffer.get(sessionId) || '') + data
    );

    // 尝试解析 JSON 行
    const lines = data.trim().split('\n').filter(l => l.startsWith('{'));
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        this.parseMessage(sessionId, parsed);
      } catch {
        // 非 JSON 数据，可能是普通文本
        this.emit('stdout', { sessionId, text: data });
      }
    }
  }

  /**
   * 解析消息
   */
  private parseMessage(sessionId: string, msg: Record<string, unknown>): void {
    const type = msg.type as string;

    switch (type) {
      case 'user':
        // 用户消息确认
        this.emit('message', {
          type: 'user',
          content: msg.content as string,
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
        break;

      case 'assistant':
      case 'text':
        // 助手文本回复
        this.emit('message', {
          type: 'assistant',
          content: msg.content as string,
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
        break;

      case 'tool_use':
        // 工具调用
        this.emit('toolUse', {
          type: 'tool_use',
          tool: msg.tool as string,
          toolInput: msg.input as Record<string, unknown>,
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
        break;

      case 'tool_result':
        // 工具结果
        this.emit('toolResult', {
          type: 'tool_result',
          tool: msg.tool as string,
          toolResult: typeof msg.result === 'string' 
            ? msg.result 
            : JSON.stringify(msg.result),
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
        break;

      case 'error':
        // 错误
        this.emit('error', {
          type: 'error',
          content: msg.error as string,
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
        break;

      case 'permission':
        // 权限请求
        const session = this.sessions.get(sessionId);
        if (session) session.status = 'waiting_permission';
        
        this.emit('permission', {
          type: 'permission',
          tool: msg.tool as string,
          toolInput: msg.input as Record<string, unknown>,
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
        break;

      case '停顿':
      case 'ping':
        // 跳过这些消息类型
        break;

      default:
        this.emit('message', {
          type: 'assistant',
          content: JSON.stringify(msg),
          sessionId,
          timestamp: new Date(),
        } as ClaudeMessage);
    }
  }

  /**
   * 响应权限请求
   */
  respondToPermission(sessionId: string, approved: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session?.process?.stdin?.writable) {
      throw new Error('Cannot respond to permission');
    }

    session.status = 'running';

    const response = JSON.stringify({
      type: 'permission_response',
      approved,
    }) + '\n';

    session.process.stdin.write(response);
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): ClaudeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): ClaudeSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 关闭会话
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.process) {
      session.process.kill('SIGTERM');
      this.sessions.delete(sessionId);
      this.outputBuffer.delete(sessionId);
    }
  }

  /**
   * 关闭所有会话
   */
  async closeAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.closeSession(sessionId);
    }
  }
}

// 导出单例
let runnerInstance: ClaudeRunner | null = null;

export function getRunner(): ClaudeRunner {
  if (!runnerInstance) {
    runnerInstance = new ClaudeRunner();
  }
  return runnerInstance;
}
