/**
 * 子Agent任务管理 - 在飞书中呈现子Agent执行状态
 * 
 * 功能：
 * - 创建子Agent任务卡片
 * - 更新任务状态
 * - 汇总子Agent结果
 */

import { renderer } from '../feishu/renderer.js';
import type { FeishuCardData } from '../feishu/renderer.js';

// 子Agent任务状态
export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubAgentTask {
  id: string;
  name: string;
  description: string;
  status: SubAgentStatus;
  result?: string;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  parentSessionId: string;
  messageId?: string; // 飞书消息ID
}

// 活跃任务记录
const activeTasks: Map<string, SubAgentTask> = new Map();

// 回调接口
export interface SubAgentCallbacks {
  sendCard?: (card: FeishuCardData) => Promise<string>;
  updateCard?: (messageId: string, card: FeishuCardData) => Promise<void>;
  sendMessage?: (text: string) => Promise<void>;
}

export class SubAgentManager {
  private callbacks: SubAgentCallbacks = {};
  private taskCounter = 0;

  /**
   * 设置回调
   */
  setCallbacks(callbacks: SubAgentCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 创建新任务
   */
  async createTask(
    name: string,
    description: string,
    parentSessionId: string
  ): Promise<SubAgentTask> {
    const id = `agent-${++this.taskCounter}-${Date.now()}`;
    
    const task: SubAgentTask = {
      id,
      name,
      description,
      status: 'pending',
      createdAt: new Date(),
      parentSessionId,
    };

    activeTasks.set(id, task);

    // 发送任务卡片
    if (this.callbacks.sendCard) {
      const card = renderer.renderSubAgent(id, description, 'running');
      const messageId = await this.callbacks.sendCard(card);
      task.messageId = messageId;
    }

    return task;
  }

  /**
   * 标记任务开始
   */
  async startTask(taskId: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (!task) return;

    task.status = 'running';
    task.startedAt = new Date();

    // 更新卡片
    if (this.callbacks.updateCard && task.messageId) {
      const card = renderer.renderSubAgent(taskId, task.description, 'running');
      await this.callbacks.updateCard(task.messageId, card);
    }
  }

  /**
   * 标记任务完成
   */
  async completeTask(taskId: string, result: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date();

    // 更新卡片
    if (this.callbacks.updateCard && task.messageId) {
      const card = renderer.renderSubAgent(taskId, task.description, 'completed');
      await this.callbacks.updateCard(task.messageId, card);
    }

    // 发送结果摘要
    if (this.callbacks.sendMessage) {
      const summary = this.summarizeResult(result);
      await this.callbacks.sendMessage(`✅ 子Agent #${taskId.slice(-8)} 完成\n\n${summary}`);
    }
  }

  /**
   * 标记任务失败
   */
  async failTask(taskId: string, error: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (!task) return;

    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date();

    // 更新卡片
    if (this.callbacks.updateCard && task.messageId) {
      const card = renderer.renderSubAgent(taskId, task.description, 'failed');
      await this.callbacks.updateCard(task.messageId, card);
    }

    // 发送错误摘要
    if (this.callbacks.sendMessage) {
      await this.callbacks.sendMessage(`❌ 子Agent #${taskId.slice(-8)} 失败\n\n错误: ${error.slice(0, 200)}`);
    }
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (!task) return;

    task.status = 'cancelled';
    task.completedAt = new Date();

    // 更新卡片
    if (this.callbacks.updateCard && task.messageId) {
      const card = renderer.renderSubAgent(taskId, task.description, 'failed');
      await this.callbacks.updateCard(task.messageId, card);
    }
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): SubAgentTask | undefined {
    return activeTasks.get(taskId);
  }

  /**
   * 获取父会话的所有任务
   */
  getTasksByParent(parentSessionId: string): SubAgentTask[] {
    return Array.from(activeTasks.values())
      .filter(t => t.parentSessionId === parentSessionId);
  }

  /**
   * 获取所有活跃任务
   */
  getActiveTasks(): SubAgentTask[] {
    return Array.from(activeTasks.values())
      .filter(t => t.status === 'pending' || t.status === 'running');
  }

  /**
   * 获取任务摘要
   */
  getTaskSummary(parentSessionId: string): string {
    const tasks = this.getTasksByParent(parentSessionId);
    
    if (tasks.length === 0) {
      return '无活跃子Agent任务';
    }

    const completed = tasks.filter(t => t.status === 'completed').length;
    const running = tasks.filter(t => t.status === 'running').length;
    const failed = tasks.filter(t => t.status === 'failed').length;

    return `子Agent 任务: ${completed}/${tasks.length} 完成, ${running} 运行中, ${failed} 失败`;
  }

  /**
   * 清理已完成的任务
   */
  cleanup(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [id, task] of activeTasks) {
      if (task.completedAt && now - task.completedAt.getTime() > maxAgeMs) {
        activeTasks.delete(id);
      }
    }
  }

  /**
   * 汇总结果
   */
  private summarizeResult(result: string): string {
    if (!result) return '无结果';

    const lines = result.split('\n').filter(l => l.trim());
    
    if (lines.length <= 3) {
      return result.slice(0, 500);
    }

    // 返回前几行和总行数
    const preview = lines.slice(0, 5).join('\n');
    const remaining = lines.length - 5;
    
    return `${preview}\n\n... 还有 ${remaining} 行`;
  }
}

// 导出单例
export const subAgentManager = new SubAgentManager();
