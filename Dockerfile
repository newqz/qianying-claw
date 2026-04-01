FROM node:22-alpine

# 安装 Claude Code
RUN npm install -g @anthropic-ai/claude-code

# 创建工作目录
WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制源码
COPY . .

# 构建
RUN npm run build

# 暴露端口
EXPOSE 18792

# 启动
CMD ["npm", "start"]
