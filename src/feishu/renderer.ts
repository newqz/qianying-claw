/**
 * 飞书消息渲染器 - 将 Claude Code 输出转换为飞书消息
 * 
 * 支持的消息类型：
 * - 代码块 (Code Block)
 * - Diff 对比
 * - 终端输出
 * - 错误提示
 * - 子Agent状态
 * - 进度更新
 */

import type { ClaudeMessage } from '../claude/runner.js';

// 飞书消息类型
export interface FeishuText {
  type: 'text';
  text: string;
}

export interface FeishuCode {
  type: 'code';
  text: string;
  language?: string;
}

export interface FeishuCard {
  type: 'card';
  data: FeishuCardData;
}

export interface FeishuCardData {
  config?: {
    wide_screen_mode?: boolean;
  };
  header?: {
    title?: {
      tag?: string;
      content?: string;
    };
    template?: string;
  };
  elements: FeishuCardElement[];
}

export interface FeishuCardElement {
  tag: string;
  text?: {
    tag?: string;
    content?: string;
    href?: string;
  };
  code?: {
    language?: number;
    content?: string;
  };
  actions?: FeishuCardAction[];
}

export interface FeishuCardAction {
  tag: string;
  text?: {
    tag?: string;
    content?: string;
  };
  type?: string;
  value?: Record<string, string>;
}

// 工具名称映射到中文
const TOOL_NAMES: Record<string, string> = {
  'Bash': '终端命令',
  'Read': '读取文件',
  'Write': '写入文件',
  'Edit': '编辑文件',
  'NotebookEdit': '笔记本编辑',
  'Glob': '搜索文件',
  'Grep': '搜索内容',
  'WebSearch': '网络搜索',
  'WebFetch': '获取网页',
  'Task': '创建任务',
  'TodoWrite': '待办事项',
  'Agent': '子Agent',
  'MultiAgent': '多Agent',
};

export class FeishuRenderer {
  /**
   * 渲染工具调用
   */
  renderToolUse(msg: ClaudeMessage): FeishuCardData {
    const toolName = msg.tool || 'Unknown';
    const toolNameCN = TOOL_NAMES[toolName] || toolName;
    const input = msg.toolInput || {};

    const elements: FeishuCardElement[] = [
      {
        tag: 'markdown',
        text: {
          content: `**🔧 ${toolNameCN}**\n\`\`\`json\n${this.formatInput(input)}\n\`\`\``,
        },
      },
    ];

    // 根据工具类型添加快捷操作
    if (toolName === 'Bash' && input.command) {
      elements.push({
        tag: 'note',
        text: {
          content: `📍 执行目录: 将在终端中运行此命令`,
        },
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `🔧 ${toolNameCN}`,
        },
        template: 'blue',
      },
      elements,
    };
  }

  /**
   * 渲染工具结果
   */
  renderToolResult(msg: ClaudeMessage): FeishuCardData {
    const toolName = msg.tool || 'Unknown';
    const toolNameCN = TOOL_NAMES[toolName] || toolName;
    const result = msg.toolResult || '';
    
    // 检测输出类型
    const isJson = this.isJsonString(result);
    const isMultiLine = result.split('\n').length > 3;
    const isError = result.toLowerCase().includes('error') || 
                    result.toLowerCase().includes('failed');

    const elements: FeishuCardElement[] = [];

    // 添加结果内容
    if (isJson) {
      elements.push({
        tag: 'markdown',
        text: {
          content: `✅ **${toolNameCN} 结果**\n\`\`\`json\n${this.truncate(result, 2000)}\n\`\`\``,
        },
      });
    } else if (isMultiLine) {
      // 多行输出，用代码块
      const language = this.detectLanguage(result);
      elements.push({
        tag: 'markdown',
        text: {
          content: `✅ **${toolNameCN} 结果**\n\`\`\`${language}\n${this.truncate(result, 3000)}\n\`\`\``,
        },
      });
    } else {
      // 单行输出，直接显示
      elements.push({
        tag: 'markdown',
        text: {
          content: `✅ **${toolNameCN}**\n${this.escape(this.truncate(result, 500))}`,
        },
      });
    }

    // 如果是错误，添加错误样式
    if (isError) {
      return {
        config: { wide_screen_mode: true },
        header: {
          title: {
            tag: 'plain_text',
            content: `❌ ${toolNameCN} 出错`,
          },
          template: 'red',
        },
        elements,
      };
    }

    return {
      config: { wide_screen_mode: true },
      elements,
    };
  }

  /**
   * 渲染代码块
   */
  renderCode(content: string, language: string = 'typescript'): FeishuCardData {
    return {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'markdown',
          text: {
            content: `\`\`\`${language}\n${this.truncate(content, 4000)}\n\`\`\``,
          },
        },
      ],
    };
  }

  /**
   * 渲染 Diff 对比
   */
  renderDiff(before: string, after: string, filePath?: string): FeishuCardData {
    const header = filePath ? `📝 ${filePath}` : '📝 文件修改';
    
    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: header,
        },
        template: 'purple',
      },
      elements: [
        {
          tag: 'markdown',
          text: {
            content: `**修改前:**\n\`\`\`\n${this.truncate(before, 1000)}\n\`\`\`\n\n**修改后:**\n\`\`\`\n${this.truncate(after, 1000)}\n\`\`\``,
          },
        },
      ],
    };
  }

  /**
   * 渲染终端输出
   */
  renderTerminal(output: string, command?: string): FeishuCardData {
    const elements: FeishuCardElement[] = [];

    if (command) {
      elements.push({
        tag: 'markdown',
        text: {
          content: `**$ ** \`${this.escape(command)}\``,
        },
      });
    }

    elements.push({
      tag: 'markdown',
      text: {
        content: `\`\`\`bash\n${this.truncate(output, 3000)}\n\`\`\``,
      },
    });

    return {
      config: { wide_screen_mode: true },
      elements,
    };
  }

  /**
   * 渲染子Agent状态
   */
  renderSubAgent(
    agentId: string, 
    task: string, 
    status: 'running' | 'completed' | 'failed'
  ): FeishuCardData {
    const statusIcon = status === 'running' ? '🤖' : status === 'completed' ? '✅' : '❌';
    const statusText = status === 'running' ? '运行中' : status === 'completed' ? '已完成' : '失败';
    const template = status === 'running' ? 'blue' : status === 'completed' ? 'green' : 'red';

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `${statusIcon} 子Agent #${agentId.slice(0, 8)} - ${statusText}`,
        },
        template,
      },
      elements: [
        {
          tag: 'markdown',
          text: {
            content: `**任务:** ${this.escape(task)}`,
          },
        },
      ],
    };
  }

  /**
   * 渲染错误消息
   */
  renderError(error: string, context?: string): FeishuCardData {
    const elements: FeishuCardElement[] = [
      {
        tag: 'markdown',
        text: {
          content: `❌ **错误**\n\`\`\`\n${this.escape(this.truncate(error, 2000))}\n\`\`\``,
        },
      },
    ];

    if (context) {
      elements.push({
        tag: 'markdown',
        text: {
          content: `**上下文:** ${this.escape(context)}`,
        },
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: '❌ 执行出错',
        },
        template: 'red',
      },
      elements,
    };
  }

  /**
   * 渲染权限请求
   */
  renderPermissionRequest(
    tool: string,
    input: Record<string, unknown>,
    sessionId: string
  ): FeishuCardData {
    const toolNameCN = TOOL_NAMES[tool] || tool;

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `⚠️ 需要权限: ${toolNameCN}`,
        },
        template: 'orange',
      },
      elements: [
        {
          tag: 'markdown',
          text: {
            content: `Claude Code 请求执行 **${toolNameCN}** 操作\n\n**详情:**\n\`\`\`json\n${this.formatInput(input)}\n\`\`\`\n\n请确认是否允许执行。`,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '✅ 允许',
              },
              type: 'primary',
              value: {
                action: 'permission',
                sessionId,
                approved: 'true',
              },
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '❌ 拒绝',
              },
              type: 'default',
              value: {
                action: 'permission',
                sessionId,
                approved: 'false',
              },
            },
          ],
        },
      ],
    };
  }

  /**
   * 渲染进度更新
   */
  renderProgress(message: string, progress?: number): FeishuCardData {
    return {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'markdown',
          text: {
            content: progress !== undefined
              ? `⏳ ${message} (${progress}%)`
              : `⏳ ${message}`,
          },
        },
      ],
    };
  }

  /**
   * 渲染最终回复
   */
  renderFinalResponse(content: string): FeishuCardData {
    return {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'markdown',
          text: {
            content,
          },
        },
      ],
    };
  }

  // ========== 辅助方法 ==========

  private formatInput(input: Record<string, unknown>): string {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '\n... (内容已截断)';
  }

  private escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private isJsonString(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  private detectLanguage(content: string): string {
    if (content.includes('function') || content.includes('const ') || content.includes('let ')) {
      return 'javascript';
    }
    if (content.includes('def ') || content.includes('import ') && content.includes(':')) {
      return 'python';
    }
    if (content.includes('package ') || content.includes('func ') || content.includes('import "')) {
      return 'go';
    }
    if (content.includes('public class') || content.includes('private void')) {
      return 'java';
    }
    return 'bash';
  }
}

// 导出单例
export const renderer = new FeishuRenderer();
