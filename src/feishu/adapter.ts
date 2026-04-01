/**
 * 飞书适配器 - 处理飞书消息的接收和发送
 * 
 * 注意：此模块仅用于开发/测试
 * 正式环境使用 OpenClaw Gateway 的飞书通道
 */

import type { FeishuCardData } from './renderer.js';

// 飞书消息事件类型
export interface FeishuMessageEvent {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: {
    sender?: {
      sender_id: {
        open_id: string;
        user_id?: string;
        union_id?: string;
      };
      sender_type: string;
      tenant_key: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      chat_id: string;
      chat_type: 'p2p' | 'group';
      message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'interactive';
      content: string;
    };
  };
}

// 用户会话映射
interface UserSession {
  openId: string;
  claudeSessionId: string;
  lastActivity: Date;
}

export class FeishuAdapter {
  private sessions: Map<string, UserSession> = new Map();
  private messageHandlers: ((event: FeishuMessageEvent) => Promise<void>)[] = [];

  /**
   * 注册消息处理器
   */
  onMessage(handler: (event: FeishuMessageEvent) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  /**
   * 处理接收到的消息
   */
  async handleMessage(event: FeishuMessageEvent): Promise<void> {
    const openId = event.event.sender?.sender_id?.open_id || 'unknown';
    const messageType = event.event.message.message_type;
    const content = event.event.message.content;
    const chatType = event.event.message.chat_type;

    // 忽略群组中非@机器人的消息
    if (chatType === 'group' && !content.includes('open_id')) {
      return;
    }

    // 解析消息内容
    let text = '';
    if (messageType === 'text') {
      try {
        const parsed = JSON.parse(content);
        text = parsed.text || '';
      } catch {
        text = content;
      }
    }

    // 更新会话
    this.updateSession(openId);

    // 触发处理器
    for (const handler of this.messageHandlers) {
      await handler(event);
    }
  }

  /**
   * 创建用户会话
   */
  createSession(openId: string, claudeSessionId: string): void {
    this.sessions.set(openId, {
      openId,
      claudeSessionId,
      lastActivity: new Date(),
    });
  }

  /**
   * 获取用户的 Claude Session
   */
  getSession(openId: string): string | undefined {
    const session = this.sessions.get(openId);
    return session?.claudeSessionId;
  }

  /**
   * 更新会话活跃时间
   */
  private updateSession(openId: string): void {
    const session = this.sessions.get(openId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * 清理过期会话
   */
  cleanupSessions(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [openId, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        this.sessions.delete(openId);
      }
    }
  }

  /**
   * 格式化文本消息用于发送
   */
  formatTextMessage(text: string): string {
    return JSON.stringify({
      text,
    });
  }

  /**
   * 格式化卡片消息用于发送
   */
  formatCardMessage(card: FeishuCardData): string {
    return JSON.stringify({
      config: {
        wide_screen_mode: card.config?.wide_screen_mode ?? true,
      },
      header: card.header,
      elements: card.elements,
    });
  }

  /**
   * 从飞书事件中提取文本内容
   */
  extractText(event: FeishuMessageEvent): string {
    const content = event.event.message.content;
    
    if (event.event.message.message_type === 'text') {
      try {
        const parsed = JSON.parse(content);
        return parsed.text || '';
      } catch {
        return content;
      }
    }
    
    return `[${event.event.message.message_type} 消息]`;
  }

  /**
   * 获取发送者 Open ID
   */
  getSenderOpenId(event: FeishuMessageEvent): string {
    return event.event.sender?.sender_id?.open_id || 'unknown';
  }

  /**
   * 获取聊天 ID
   */
  getChatId(event: FeishuMessageEvent): string {
    return event.event.message.chat_id;
  }

  /**
   * 获取消息 ID
   */
  getMessageId(event: FeishuMessageEvent): string {
    return event.event.message.message_id;
  }

  /**
   * 是群组聊天
   */
  isGroupChat(event: FeishuMessageEvent): boolean {
    return event.event.message.chat_type === 'group';
  }
}

// 导出单例
export const feishuAdapter = new FeishuAdapter();
