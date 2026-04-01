/**
 * 工具调用同步器 - 同步 Claude Code 工具调用状态到飞书
 * 
 * 功能：
 * - 工具开始调用时发送状态消息
 * - 工具完成时发送结果消息
 * - 支持权限审批流程
 */

import type { ClaudeMessage } from '../claude/runner.js';
import { renderer } from '../feishu/renderer.js';
import type { FeishuCardData } from '../feishu/renderer.js';

// 工具调用状态
export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  startTime: Date;
  endTime?: Date;
  sessionId: string;
  messageId?: string; // 飞书消息ID，用于更新
}

// 工具调用记录
const activeCalls: Map<string, ToolCall> = new Map();

// 回调接口
export interface ToolSyncCallbacks {
  onToolStart?: (call: ToolCall) => Promise<void>;
  onToolResult?: (call: ToolCall) => Promise<void>;
  onToolError?: (call: ToolCall, error: string) => Promise<void>;
  onPermissionRequest?: (call: ToolCall) => Promise<void>;
  sendCard?: (card: FeishuCardData) => Promise<string>; // 返回消息ID
  updateCard?: (messageId: string, card: FeishuCardData) => Promise<void>;
}

export class ToolSync {
  private callbacks: ToolSyncCallbacks = {};
  private callCounter = 0;

  /**
   * 设置回调
   */
  setCallbacks(callbacks: ToolSyncCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 处理工具调用开始
   */
  async handleToolUse(msg: ClaudeMessage): Promise<void> {
    const id = `tool-${++this.callCounter}-${Date.now()}`;
    
    const call: ToolCall = {
      id,
      tool: msg.tool || 'Unknown',
      input: msg.toolInput || {},
      status: 'running',
      startTime: new Date(),
      sessionId: msg.sessionId,
    };

    activeCalls.set(id, call);

    // 渲染并发送工具开始卡片
    if (this.callbacks.sendCard) {
      const card = renderer.renderToolUse(msg);
      const messageId = await this.callbacks.sendCard(card);
      call.messageId = messageId;
    }

    // 触发回调
    await this.callbacks.onToolStart?.(call);
  }

  /**
   * 处理工具结果
   */
  async handleToolResult(msg: ClaudeMessage): Promise<void> {
    // 找到对应的工具调用
    const call = this.findPendingCall(msg.sessionId, msg.tool);
    
    if (call) {
      call.status = 'completed';
      call.result = msg.toolResult;
      call.endTime = new Date();

      // 渲染并更新消息卡片
      if (this.callbacks.updateCard && call.messageId) {
        const card = renderer.renderToolResult(msg);
        await this.callbacks.updateCard(call.messageId, card);
      }

      await this.callbacks.onToolResult?.(call);
      activeCalls.delete(call.id);
    } else {
      // 找不到对应的调用，直接渲染结果
      if (this.callbacks.sendCard) {
        const card = renderer.renderToolResult(msg);
        await this.callbacks.sendCard(card);
      }
    }
  }

  /**
   * 处理权限请求
   */
  async handlePermission(msg: ClaudeMessage): Promise<void> {
    const id = `perm-${++this.callCounter}-${Date.now()}`;
    
    const call: ToolCall = {
      id,
      tool: msg.tool || 'Unknown',
      input: msg.toolInput || {},
      status: 'pending',
      startTime: new Date(),
      sessionId: msg.sessionId,
    };

    activeCalls.set(id, call);

    // 渲染权限请求卡片
    if (this.callbacks.sendCard) {
      const card = renderer.renderPermissionRequest(
        msg.tool || 'Unknown',
        msg.toolInput || {},
        msg.sessionId
      );
      const messageId = await this.callbacks.sendCard(card);
      call.messageId = messageId;
    }

    await this.callbacks.onPermissionRequest?.(call);
  }

  /**
   * 处理错误
   */
  async handleError(msg: ClaudeMessage): Promise<void> {
    const call = this.findPendingCall(msg.sessionId);
    
    if (call) {
      call.status = 'failed';
      call.endTime = new Date();

      if (this.callbacks.updateCard && call.messageId) {
        const card = renderer.renderError(
          msg.content,
          `Tool: ${call.tool}`
        );
        await this.callbacks.updateCard(call.messageId, card);
      }

      await this.callbacks.onToolError?.(call, msg.content);
      activeCalls.delete(call.id);
    } else if (this.callbacks.sendCard) {
      const card = renderer.renderError(msg.content);
      await this.callbacks.sendCard(card);
    }
  }

  /**
   * 查找待处理的工具调用
   */
  private findPendingCall(sessionId: string, tool?: string): ToolCall | undefined {
    for (const call of activeCalls.values()) {
      if (call.sessionId === sessionId && call.status === 'running') {
        if (!tool || call.tool === tool) {
          return call;
        }
      }
    }
    return undefined;
  }

  /**
   * 获取所有活跃调用
   */
  getActiveCalls(): ToolCall[] {
    return Array.from(activeCalls.values());
  }

  /**
   * 获取调用的持续时间
   */
  getCallDuration(call: ToolCall): number {
    const end = call.endTime || new Date();
    return end.getTime() - call.startTime.getTime();
  }

  /**
   * 格式化调用为状态字符串
   */
  formatCallStatus(call: ToolCall): string {
    const duration = this.getCallDuration(call);
    const durationStr = duration > 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`;
    
    const statusIcon = call.status === 'completed' ? '✅' 
                     : call.status === 'failed' ? '❌'
                     : call.status === 'pending' ? '⏳'
                     : '🔄';
    
    return `${statusIcon} ${call.tool} (${durationStr})`;
  }
}

// 导出单例
export const toolSync = new ToolSync();
