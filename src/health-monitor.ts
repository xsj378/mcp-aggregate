import { MCPHealthCheck, MCPServerMetrics } from './types.js';
import { MetricsManager } from './metrics-manager.js';
import { ConnectedClient } from './client.js';
import { z } from 'zod';

// 简单的健康检查响应schema
const HealthCheckResponseSchema = z.object({
  tools: z.array(z.any()).optional()
});

export class HealthMonitor {
  private healthChecks: Map<string, MCPHealthCheck> = new Map();
  private metricsManager: MetricsManager;
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs = 30000; // 30秒检查一次
  private readonly timeoutMs = 5000; // 5秒超时
  private onServerUnhealthy?: (serverName: string) => void; // 添加回调函数

  constructor(metricsManager: MetricsManager, onServerUnhealthy?: (serverName: string) => void) {
    this.metricsManager = metricsManager;
    this.onServerUnhealthy = onServerUnhealthy;
  }

  startMonitoring(connectedClients: ConnectedClient[]): void {
    // 初始化健康检查
    for (const client of connectedClients) {
      this.healthChecks.set(client.name, {
        serverName: client.name,
        isHealthy: true,
        lastCheck: new Date()
      });
    }

    // 开始定期检查
    this.checkInterval = setInterval(() => {
      this.performHealthChecks(connectedClients);
    }, this.checkIntervalMs);

    console.log(`Health monitoring started for ${connectedClients.length} servers`);
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('Health monitoring stopped');
    }
  }

  private async performHealthChecks(connectedClients: ConnectedClient[]): Promise<void> {
    console.log(`🔄 开始健康检查，共 ${connectedClients.length} 个服务器`);
    
    // 使用 Promise.allSettled 确保一个服务器的失败不会影响其他服务器
    const checkPromises = connectedClients.map(async (client) => {
      try {
        await this.checkServerHealth(client);
        console.log(`✅ ${client.name} 健康检查完成`);
      } catch (error) {
        console.error(`❌ ${client.name} 健康检查失败:`, error);
        // 即使健康检查失败，也不影响其他服务器
      }
    });

    await Promise.allSettled(checkPromises);
    console.log('🏁 所有服务器健康检查完成');
  }

  private async checkServerHealth(client: ConnectedClient): Promise<void> {
    const startTime = Date.now();
    let isHealthy = false;
    let errorMessage: string | undefined;

    try {
      // 首先检查连接状态
      if (!client.isConnected) {
        isHealthy = false;
        errorMessage = client.lastError || 'Connection lost';
        console.warn(`Health check failed for ${client.name}: ${errorMessage}`);
      } else {
        // 对于SSE连接，进行额外的状态检查
        if (client.name === 'Example Server 3') { // 根据您的配置
          console.log(`🔍 检查SSE连接 ${client.name} 的状态...`);
          
          // 如果连接状态为true但lastError存在，说明可能有隐藏的问题
          if (client.lastError) {
            isHealthy = false;
            errorMessage = client.lastError;
            console.warn(`SSE连接 ${client.name} 检测到错误: ${errorMessage}`);
          } else {
            // 尝试发送一个简单的请求来验证连接
            try {
              // 这里可以添加一个简单的连接测试
              isHealthy = true;
              console.log(`✅ SSE连接 ${client.name} 健康检查通过`);
            } catch (testError) {
              isHealthy = false;
              errorMessage = testError instanceof Error ? testError.message : 'Connection test failed';
              console.warn(`SSE连接 ${client.name} 健康检查失败: ${errorMessage}`);
            }
          }
        } else {
          // 如果连接状态正常，认为服务器健康
          isHealthy = true;
        }
      }
    } catch (error) {
      isHealthy = false;
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Health check failed for ${client.name}: ${errorMessage}`);
      
      // 更新客户端连接状态
      client.isConnected = false;
      client.lastError = errorMessage;
    }

    const responseTime = Date.now() - startTime;

    // 更新健康检查状态
    const healthCheck: MCPHealthCheck = {
      serverName: client.name,
      isHealthy,
      lastCheck: new Date(),
      errorMessage,
      responseTime
    };

    this.healthChecks.set(client.name, healthCheck);

    // 更新指标管理器 - 只更新健康状态，不记录请求
    try {
      if (isHealthy) {
        this.metricsManager.markServerHealthy(client.name);
        // 健康检查成功，不记录为请求
      } else {
        this.metricsManager.markServerUnhealthy(client.name, errorMessage);
        // 健康检查失败，不记录为请求，只标记为不健康
        
        // 不要立即移除服务器，而是先标记为不健康
        // 只有在连续多次失败后，才通过其他机制移除
        console.warn(`服务器 ${client.name} 标记为不健康: ${errorMessage}`);
      }
    } catch (metricsError) {
      console.error(`Failed to update metrics for ${client.name}:`, metricsError);
      // 指标更新失败不应该影响健康检查结果
    }
  }

  // 手动触发健康检查
  async triggerHealthCheck(client: ConnectedClient): Promise<MCPHealthCheck> {
    const startTime = Date.now();
    let isHealthy = false;
    let errorMessage: string | undefined;

    try {
      // 首先检查连接状态
      if (!client.isConnected) {
        isHealthy = false;
        errorMessage = client.lastError || 'Connection lost';
      } else {
        // 如果连接状态正常，认为服务器健康
        isHealthy = true;
      }
    } catch (error) {
      isHealthy = false;
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // 更新客户端连接状态
      client.isConnected = false;
      client.lastError = errorMessage;
    }

    const responseTime = Date.now() - startTime;

    const healthCheck: MCPHealthCheck = {
      serverName: client.name,
      isHealthy,
      lastCheck: new Date(),
      errorMessage,
      responseTime
    };

    this.healthChecks.set(client.name, healthCheck);

    // 更新指标管理器 - 只更新健康状态，不记录请求
    if (isHealthy) {
      this.metricsManager.markServerHealthy(client.name);
      // 手动健康检查成功，不记录为请求
    } else {
      this.metricsManager.markServerUnhealthy(client.name, errorMessage);
      // 手动健康检查失败，不记录为请求，只标记为不健康
      console.warn(`手动健康检查失败 for ${client.name}: ${errorMessage}`);
    }

    return healthCheck;
  }

  getHealthStatus(serverName: string): MCPHealthCheck | undefined {
    return this.healthChecks.get(serverName);
  }

  getAllHealthStatuses(): MCPHealthCheck[] {
    return Array.from(this.healthChecks.values());
  }

  getHealthyServers(): string[] {
    return Array.from(this.healthChecks.values())
      .filter(check => check.isHealthy)
      .map(check => check.serverName);
  }

  getUnhealthyServers(): string[] {
    return Array.from(this.healthChecks.values())
      .filter(check => !check.isHealthy)
      .map(check => check.serverName);
  }

  getHealthSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    averageResponseTime: number;
  } {
    const allChecks = this.getAllHealthStatuses();
    const healthyChecks = allChecks.filter(check => check.isHealthy);
    
    const averageResponseTime = healthyChecks.length > 0
      ? healthyChecks.reduce((sum, check) => sum + (check.responseTime || 0), 0) / healthyChecks.length
      : 0;

    return {
      total: allChecks.length,
      healthy: healthyChecks.length,
      unhealthy: allChecks.length - healthyChecks.length,
      averageResponseTime
    };
  }

  // 检查服务器是否应该被标记为不健康
  shouldMarkUnhealthy(serverName: string, consecutiveFailures: number): boolean {
    const healthCheck = this.healthChecks.get(serverName);
    if (!healthCheck) return false;

    // 提高阈值，减少误判
    const maxConsecutiveFailures = 5; // 从3增加到5
    return consecutiveFailures >= maxConsecutiveFailures;
  }

  // 检查服务器是否可以恢复
  canRecover(serverName: string): boolean {
    const healthCheck = this.healthChecks.get(serverName);
    if (!healthCheck) return false;

    // 如果最后一次检查时间超过恢复时间窗口，允许恢复
    const recoveryWindowMs = 60000; // 1分钟
    const timeSinceLastCheck = Date.now() - healthCheck.lastCheck.getTime();
    
    return timeSinceLastCheck > recoveryWindowMs;
  }
} 