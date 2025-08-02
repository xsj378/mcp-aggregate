import express from 'express';
import { MetricsManager } from './metrics-manager.js';
import { HealthMonitor } from './health-monitor.js';
import { SmartSelector } from './selection-strategies.js';
import { ConnectedClient } from './client.js';

export class MonitoringDashboard {
  private app: express.Application;
  private metricsManager: MetricsManager;
  private healthMonitor: HealthMonitor;
  private smartSelector: SmartSelector;
  private connectedClients: ConnectedClient[];

  constructor(
    metricsManager: MetricsManager,
    healthMonitor: HealthMonitor,
    smartSelector: SmartSelector,
    connectedClients: ConnectedClient[]
  ) {
    this.metricsManager = metricsManager;
    this.healthMonitor = healthMonitor;
    this.smartSelector = smartSelector;
    this.connectedClients = connectedClients;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // 获取所有服务器状态
    this.app.get('/api/servers/status', (req, res) => {
      const allMetrics = this.metricsManager.getAllMetrics();
      const healthStatuses = this.healthMonitor.getAllHealthStatuses();
      const qualityScores = this.metricsManager.getAllQualityScores();

      const serverStatus = this.connectedClients.map(client => {
        const metrics = allMetrics.find(m => m.serverName === client.name);
        const health = healthStatuses.find(h => h.serverName === client.name);
        const quality = qualityScores.find(q => q.serverName === client.name);

        return {
          name: client.name,
          metrics,
          health,
          quality,
          isConnected: client.isConnected // 使用实际的连接状态
        };
      });

      res.json({
        servers: serverStatus,
        summary: {
          total: serverStatus.length,
          healthy: serverStatus.filter(s => s.isConnected && s.health?.isHealthy).length,
          unhealthy: serverStatus.filter(s => !s.isConnected || !s.health?.isHealthy).length,
          averageResponseTime: this.calculateAverageResponseTime(allMetrics),
          averageSuccessRate: this.calculateAverageSuccessRate(allMetrics)
        }
      });
    });

    // 获取服务器性能指标
    this.app.get('/api/servers/metrics', (req, res) => {
      const metrics = this.metricsManager.getAllMetrics();
      const topServers = this.metricsManager.getTopServers(10);
      
      res.json({
        metrics,
        topServers,
        stats: this.metricsManager.getServerStats()
      });
    });

    // 获取健康检查状态
    this.app.get('/api/servers/health', (req, res) => {
      const healthSummary = this.healthMonitor.getHealthSummary();
      const healthStatuses = this.healthMonitor.getAllHealthStatuses();
      
      res.json({
        summary: healthSummary,
        statuses: healthStatuses
      });
    });

    // 获取选择策略信息
    this.app.get('/api/selection/strategies', (req, res) => {
      const strategies = this.smartSelector.getAvailableStrategies();
      
      res.json({
        strategies,
        currentStrategy: 'adaptive' // 可以从配置中获取
      });
    });

    // 获取工具映射信息
    this.app.get('/api/mapping/tools', (req, res) => {
      // 这里需要从MCP代理中获取toolToClientMap
      // 暂时返回一个占位符，实际实现需要访问MCP代理的映射
      res.json({
        message: 'Tool mapping information is available in server logs',
        note: 'Check server console for detailed tool mapping'
      });
    });

    // 手动触发健康检查
    this.app.post('/api/servers/:serverName/health-check', async (req: any, res: any) => {
      const { serverName } = req.params;
      const client = this.connectedClients.find(c => c.name === serverName);
      
      if (!client) {
        return res.status(404).json({ error: 'Server not found' });
      }

      try {
        const healthCheck = await this.healthMonitor.triggerHealthCheck(client);
        res.json(healthCheck);
      } catch (error) {
        res.status(500).json({ error: 'Health check failed' });
      }
    });

    // 手动移除服务器
    this.app.delete('/api/servers/:serverName', (req: any, res: any) => {
      const { serverName } = req.params;
      const index = this.connectedClients.findIndex(c => c.name === serverName);
      
      if (index === -1) {
        return res.status(404).json({ error: 'Server not found' });
      }

      const removedClient = this.connectedClients[index];
      this.connectedClients.splice(index, 1);
      
      console.log(`手动移除服务器: ${serverName}`);
      res.json({ 
        message: `Server ${serverName} removed successfully`,
        remainingServers: this.connectedClients.length
      });
    });

    // 获取工具列表状态
    this.app.get('/api/tools/status', (req, res) => {
      try {
        // 统计工具数量
        const toolStatus = {
          totalServers: this.connectedClients.length,
          connectedServers: this.connectedClients.filter(c => c.isConnected).length,
          serverStatus: this.connectedClients.map(client => ({
            name: client.name,
            isConnected: client.isConnected,
            lastError: client.lastError,
            lastErrorTime: client.lastError ? new Date().toISOString() : null
          }))
        };
        
        res.json(toolStatus);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // 手动重新初始化工具列表
    this.app.post('/api/servers/:serverName/reinitialize-tools', async (req: any, res: any) => {
      const { serverName } = req.params;
      const client = this.connectedClients.find(c => c.name === serverName);
      
      if (!client) {
        return res.status(404).json({ error: 'Server not found' });
      }

      try {
        // 这里可以添加重新初始化工具列表的逻辑
        console.log(`手动重新初始化 ${serverName} 的工具列表`);
        res.json({ 
          success: true, 
          message: `Reinitializing tools for ${serverName}`,
          serverName: serverName
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // 获取服务器详细性能数据
    this.app.get('/api/servers/:serverName/details', (req: any, res: any) => {
      const { serverName } = req.params;
      
      const metrics = this.metricsManager.getMetrics(serverName);
      const health = this.healthMonitor.getHealthStatus(serverName);
      const quality = this.metricsManager.getQualityScore(serverName);
      
      if (!metrics) {
        return res.status(404).json({ error: 'Server not found' });
      }

      res.json({
        name: serverName,
        metrics,
        health,
        quality,
        recommendations: this.generateRecommendations(metrics, health, quality)
      });
    });

    // 提供HTML仪表板
    this.app.get('/dashboard', (req, res) => {
      res.send(this.generateDashboardHTML());
    });

    // 静态文件服务
    this.app.use('/static', express.static('public'));
  }

  private calculateAverageResponseTime(metrics: any[]): number {
    if (metrics.length === 0) return 0;
    
    // 只计算有请求的服务器，按请求数量加权平均
    const serversWithRequests = metrics.filter(m => m.totalRequests > 0);
    if (serversWithRequests.length === 0) return 0;
    
    const totalRequests = serversWithRequests.reduce((sum, m) => sum + m.totalRequests, 0);
    const weightedSum = serversWithRequests.reduce((sum, m) => sum + (m.responseTime * m.totalRequests), 0);
    
    return weightedSum / totalRequests;
  }

  private calculateAverageSuccessRate(metrics: any[]): number {
    if (metrics.length === 0) return 0;
    
    // 只计算有请求的服务器，按请求数量加权平均
    const serversWithRequests = metrics.filter(m => m.totalRequests > 0);
    if (serversWithRequests.length === 0) return 1.0; // 没有请求时默认为100%成功率
    
    const totalRequests = serversWithRequests.reduce((sum, m) => sum + m.totalRequests, 0);
    const totalSuccessfulRequests = serversWithRequests.reduce((sum, m) => sum + (m.totalRequests - m.errorCount), 0);
    
    return totalSuccessfulRequests / totalRequests;
  }

  private generateRecommendations(metrics: any, health: any, quality: any): string[] {
    const recommendations: string[] = [];

    if (metrics.responseTime > 3000) {
      recommendations.push('响应时间较高，建议优化服务器性能');
    }

    if (metrics.successRate < 0.95) {
      recommendations.push('成功率较低，建议检查服务器稳定性');
    }

    if (metrics.loadFactor > 0.8) {
      recommendations.push('负载较高，建议增加服务器资源或减少并发请求');
    }

    if (!health?.isHealthy) {
      recommendations.push('服务器不健康，建议立即检查并修复问题');
    }

    if (quality?.overallScore < 0.7) {
      recommendations.push('综合评分较低，建议优化服务器配置');
    }

    return recommendations;
  }

  private generateDashboardHTML(): string {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Proxy 监控仪表板</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            color: #333;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .header {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        
        .header h1 {
            color: #2c3e50;
            margin-bottom: 10px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .stat-value {
            font-size: 2em;
            font-weight: bold;
            color: #3498db;
        }
        
        .stat-label {
            color: #7f8c8d;
            margin-top: 5px;
        }
        
        .servers-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        
        .server-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .server-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        
        .server-name {
            font-weight: bold;
            font-size: 1.1em;
        }
        
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
        }
        
        .status-healthy { background: #27ae60; }
        .status-unhealthy { background: #e74c3c; }
        
        .metric-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            padding: 5px 0;
            border-bottom: 1px solid #ecf0f1;
        }
        
        .metric-label {
            color: #7f8c8d;
        }
        
        .metric-value {
            font-weight: 500;
        }
        
        .refresh-btn {
            background: #3498db;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        
        .refresh-btn:hover {
            background: #2980b9;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #7f8c8d;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>MCP Proxy 监控仪表板</h1>
            <p>实时监控多MCP服务器的性能和健康状态</p>
            <button class="refresh-btn" onclick="refreshData()">刷新数据</button>
        </div>
        
        <div class="stats-grid" id="stats-grid">
            <div class="loading">加载中...</div>
        </div>
        
        <div class="servers-grid" id="servers-grid">
            <div class="loading">加载中...</div>
        </div>
    </div>

    <script>
        async function refreshData() {
            try {
                const response = await fetch('/api/servers/status');
                const data = await response.json();
                updateDashboard(data);
            } catch (error) {
                console.error('Failed to fetch data:', error);
            }
        }
        
        function updateDashboard(data) {
            updateStats(data.summary);
            updateServers(data.servers);
        }
        
        function updateStats(summary) {
            const statsGrid = document.getElementById('stats-grid');
            statsGrid.innerHTML = \`
                <div class="stat-card">
                    <div class="stat-value">\${summary.total}</div>
                    <div class="stat-label">总服务器数</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" style="color: #27ae60;">\${summary.healthy}</div>
                    <div class="stat-label">健康服务器</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" style="color: #e74c3c;">\${summary.unhealthy}</div>
                    <div class="stat-label">不健康服务器</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">\${summary.averageResponseTime.toFixed(0)}ms</div>
                    <div class="stat-label">平均响应时间</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">\${(summary.averageSuccessRate * 100).toFixed(1)}%</div>
                    <div class="stat-label">平均成功率</div>
                </div>
            \`;
        }
        
        function updateServers(servers) {
            const serversGrid = document.getElementById('servers-grid');
            serversGrid.innerHTML = servers.map(server => {
                // 判断服务器状态：需要同时满足连接和健康
                const isHealthy = server.isConnected && server.health?.isHealthy;
                const statusClass = isHealthy ? 'status-healthy' : 'status-unhealthy';
                const statusText = isHealthy ? '健康' : (server.isConnected ? '不健康' : '已断开');
                
                return \`
                <div class="server-card">
                    <div class="server-header">
                        <div class="server-name">\${server.name}</div>
                        <span class="status-indicator \${statusClass}" title="\${statusText}"></span>
                    </div>
                    \${server.metrics ? \`
                        <div class="metric-row">
                            <span class="metric-label">连接状态:</span>
                            <span class="metric-value">\${server.isConnected ? '✅ 已连接' : '❌ 已断开'}</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">健康状态:</span>
                            <span class="metric-value">\${server.health?.isHealthy ? '✅ 健康' : '❌ 不健康'}</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">响应时间:</span>
                            <span class="metric-value">\${server.metrics.responseTime.toFixed(0)}ms</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">成功率:</span>
                            <span class="metric-value">\${(server.metrics.successRate * 100).toFixed(1)}%</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">总请求数:</span>
                            <span class="metric-value">\${server.metrics.totalRequests}</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">负载因子:</span>
                            <span class="metric-value">\${(server.metrics.loadFactor * 100).toFixed(1)}%</span>
                        </div>
                    \` : '<div class="metric-row">无数据</div>'}
                    \${server.health?.errorMessage ? \`
                        <div class="metric-row">
                            <span class="metric-label">错误信息:</span>
                            <span class="metric-value" style="color: #e74c3c;">\${server.health.errorMessage}</span>
                        </div>
                    \` : ''}
                    \${server.quality ? \`
                        <div class="metric-row">
                            <span class="metric-label">综合评分:</span>
                            <span class="metric-value">\${(server.quality.overallScore * 100).toFixed(1)}%</span>
                        </div>
                    \` : ''}
                </div>
                \`;
            }).join('');
        }
        
        // 初始加载
        refreshData();
        
        // 每30秒自动刷新
        setInterval(refreshData, 30000);
    </script>
</body>
</html>
    `;
  }

  start(port: number = 3000): void {
    this.app.listen(port, () => {
      console.log(`Monitoring dashboard started at http://localhost:${port}/dashboard`);
      console.log(`API endpoints available at http://localhost:${port}/api/`);
    });
  }
} 