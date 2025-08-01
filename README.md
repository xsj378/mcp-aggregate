# MCP Proxy Server

一个智能的MCP代理服务器，聚合并服务多个MCP资源服务器，通过单一接口提供高效的MCP选用策略。该服务器作为中央枢纽，能够：

- 连接并管理多个MCP资源服务器
- 通过统一接口暴露其组合能力
- 处理请求到适当后端服务器的智能路由
- 聚合来自多个来源的响应
- **智能选择最佳MCP服务器**
- **实时监控服务器性能和健康状态**
- **自动故障转移和负载均衡**

## 核心特性

### 🧠 智能MCP选择策略
实现了5种智能选择算法：

- 自适应选择策略：根据请求类型（性能关键型、可靠性关键型、平衡型）自动选择最佳服务器
- 质量评分策略：基于综合质量评分选择服务器，考虑性能、可靠性、能力匹配度和负载因子
- 性能优先策略：专注于响应时间优化，适合对延迟敏感的应用场景
- 负载均衡策略：选择负载最低的服务器，确保资源分配的均衡性
- 轮询策略：保留原有的简单轮询分配方式

### 📊 实时性能监控

实现了完整的监控体系：
- 指标跟踪：实时跟踪每个服务器的响应时间、成功率、负载因子、健康状态
- 质量评分系统：
  * 性能评分：performanceScore = Math.max(0, 1 - (responseTime / 5000))
  * 可靠性评分：reliabilityScore = isHealthy ? successRate : 0
  * 能力匹配评分：capabilityScore = 1.0 // 默认值，可通过配置调整
  * 负载评分：基于请求频率的动态负载评估，负载越低，评分越高，loadScore = 1 - min(1, totalRequests / max(1, timeSinceLastRequest / 1000)）
  * 综合评分 = 性能评分 × 0.3 + 可靠性评分 × 0.3 + 能力匹配评分 × 0.2 + 负载评分 × 0.2
- 数据聚合：实时聚合多个服务器的性能指标，提供整体视图

### 🔄 智能故障处理
<img src="/docs/error_hand.png" width="100%" height="100%">

- 自动健康检查：定期健康检查（默认30秒间隔），自动标记不健康的服务器
- 智能故障处理：指数退避重试策略，可配置的最大重试次数，智能错误分类
- 错误隔离：一个服务器的失败不会影响其他服务器的正常运行

### 🎛️ 监控仪表板
<img src="/docs/web_monitor.png" width="100%" height="100%">

提供Web界面实时监控MCP服务器状态：

- 实时状态显示：服务器健康状态、性能指标的实时展示
- 性能统计：响应时间、成功率、负载等统计信息的可视化
- API接口：提供RESTful API用于程序化监控
- 自动刷新：5秒自动刷新数据，保持监控信息的实时性

访问地址: `http://localhost:3000/dashboard`

## 配置

服务器需要一个JSON配置文件来指定要连接的MCP服务器。复制示例配置并根据需要修改：

```bash
cp config.example.json config.json
```

### 配置结构示例

```json
{
  "servers": [
    {
      "name": "高性能服务器",
      "transport": {
        "command": "/path/to/high-performance-server/build/index.js"
      },
      "priority": 1,
      "capabilities": ["tools", "resources"],
      "maxConcurrentRequests": 10
    },
    {
      "name": "稳定服务器",
      "transport": {
        "command": "npx",
        "args": ["@example/stable-mcp-server"]
      },
      "priority": 2,
      "capabilities": ["tools", "prompts"],
      "maxConcurrentRequests": 5
    },
    {
      "name": "SSE服务器",
      "transport": {
        "type": "sse",
        "url": "http://example.com/mcp"
      },
      "priority": 3,
      "capabilities": ["resources", "prompts"],
      "maxConcurrentRequests": 8
    }
  ],
  "selectionStrategy": {
    "default": "adaptive",
    "fallback": "quality",
    "timeout": 5000,
    "maxRetries": 2,
    "healthCheckInterval": 30000
  },
  "monitoring": {
    "enabled": true,
    "metricsRetentionHours": 24,
    "alertThresholds": {
      "responseTime": 5000,
      "errorRate": 0.1,
      "unhealthyServers": 0.5
    }
  }
}
```

### 配置选项说明

#### 服务器配置
- `name`: 服务器名称
- `transport`: 传输配置 (stdio 或 sse)
- `priority`: 服务器优先级 (1-10, 1为最高)
- `capabilities`: 服务器支持的能力列表
- `maxConcurrentRequests`: 最大并发请求数

#### 选择策略配置
- `default`: 默认选择策略
- `fallback`: 备用选择策略
- `timeout`: 请求超时时间(ms)
- `maxRetries`: 最大重试次数
- `healthCheckInterval`: 健康检查间隔(ms)

#### 监控配置
- `enabled`: 是否启用监控
- `metricsRetentionHours`: 指标保留时间(小时)
- `alertThresholds`: 告警阈值配置

## 开发

安装依赖:
```bash
pnpm install
```

构建服务器:
```bash
pnpm run build
```

开发模式 (自动重建):
```bash
pnpm run watch
```

开发模式 (持续运行):
```bash
# Stdio
pnpm run dev
# SSE
pnpm run dev:sse
```

## 安装

要与Claude Desktop一起使用，添加服务器配置:

MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-proxy": {
      "command": "/path/to/mcp-proxy-server/build/index.js",
      "env": {
        "MCP_CONFIG_PATH": "/absolute/path/to/your/config.json",
        "KEEP_SERVER_OPEN": "1"
      }
    }
  }
}
```

- `KEEP_SERVER_OPEN` 将在客户端断开连接时保持SSE运行。当多个客户端连接到MCP代理时很有用。

## 监控和调试

### 监控仪表板
启动监控仪表板:
```bash
# 在代码中集成监控仪表板
const dashboard = new MonitoringDashboard(metricsManager, healthMonitor, smartSelector, connectedClients);
dashboard.start(3000);
```

访问 `http://localhost:3000/dashboard` 查看实时监控界面。

### API接口
- `GET /api/servers/status` - 获取所有服务器状态
- `GET /api/servers/metrics` - 获取性能指标
- `GET /api/servers/health` - 获取健康检查状态
- `POST /api/servers/:serverName/health-check` - 手动触发健康检查
- `GET /api/servers/:serverName/details` - 获取服务器详细信息

### 调试
由于MCP服务器通过stdio通信，调试可能具有挑战性。我们推荐使用 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)，可通过包脚本使用:

```bash
pnpm run inspector
```

Inspector将在浏览器中提供调试工具的URL。

## 智能选择策略详解

### 自适应策略工作原理

1. **请求类型检测**: 根据请求特征自动判断类型
   - 超时时间 < 1秒 → 性能关键型
   - 优先级 = high → 可靠性关键型
   - 其他 → 平衡型

2. **策略选择**:
   - 性能关键型: 选择响应时间最短的服务器
   - 可靠性关键型: 选择成功率最高的服务器
   - 平衡型: 选择综合评分最高的服务器

3. **质量评分计算**:
   ```
   综合评分 = 性能评分 × 0.3 + 可靠性评分 × 0.3 + 能力匹配度 × 0.2 + 负载评分 × 0.2
   ```

### 故障处理机制

1. **重试策略**: 指数退避重试，避免对故障服务器造成额外压力
2. **故障转移**: 主服务器失败时自动切换到备用服务器
3. **健康恢复**: 定期检查不健康服务器，自动恢复可用状态

### 性能优化

1. **连接池管理**: 复用连接，减少建立连接的开销
2. **请求缓存**: 缓存常用请求结果
3. **负载均衡**: 智能分配请求到负载较低的服务器
4. **指标聚合**: 实时聚合多个服务器的性能指标

## 最佳实践

1. **服务器配置**: 根据服务器能力设置合适的优先级和并发限制
2. **监控告警**: 配置合理的告警阈值，及时发现性能问题
3. **策略选择**: 根据应用场景选择合适的默认策略
4. **定期维护**: 定期检查服务器健康状态和性能指标
5. **容量规划**: 根据负载情况调整服务器资源配置

这个增强版的MCP代理服务器为Agent提供了智能、可靠的MCP选择能力，确保在各种场景下都能选择到最适合的MCP服务器，大大提升了系统的整体性能和可靠性。
