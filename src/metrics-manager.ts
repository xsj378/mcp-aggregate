import { MCPServerMetrics, MCPQualityScore } from './types.js';

export class MetricsManager {
  private metrics: Map<string, MCPServerMetrics> = new Map();
  private qualityScores: Map<string, MCPQualityScore> = new Map();
  private readonly maxHistorySize = 1000;
  private readonly responseTimeWindow = 100; // 最近100次请求的平均响应时间

  constructor() {
    // 定期清理过期数据
    setInterval(() => this.cleanupOldData(), 60000); // 每分钟清理一次
  }

  initializeServer(serverName: string): void {
    const initialMetrics: MCPServerMetrics = {
      serverName,
      responseTime: 0,
      successRate: 1.0,
      errorCount: 0,
      totalRequests: 0,
      lastUsed: new Date(),
      isHealthy: true,
      loadFactor: 0,
      capabilityScore: 1.0
    };

    this.metrics.set(serverName, initialMetrics);
    this.updateQualityScore(serverName);
  }

  recordRequest(serverName: string, responseTime: number, success: boolean): void {
    const metrics = this.metrics.get(serverName);
    if (!metrics) {
      this.initializeServer(serverName);
      return;
    }

    // 更新响应时间 (使用指数移动平均)
    const alpha = 0.1; // 平滑因子
    metrics.responseTime = alpha * responseTime + (1 - alpha) * metrics.responseTime;

    // 更新成功率
    metrics.totalRequests++;
    if (!success) {
      metrics.errorCount++;
    }
    metrics.successRate = 1 - (metrics.errorCount / metrics.totalRequests);

    // 更新最后使用时间
    metrics.lastUsed = new Date();

    // 更新负载因子 (基于请求频率)
    const timeSinceLastRequest = Date.now() - metrics.lastUsed.getTime();
    metrics.loadFactor = Math.min(1, metrics.totalRequests / Math.max(1, timeSinceLastRequest / 1000));

    this.metrics.set(serverName, metrics);
    this.updateQualityScore(serverName);
  }

  markServerUnhealthy(serverName: string, errorMessage?: string): void {
    const metrics = this.metrics.get(serverName);
    if (metrics) {
      metrics.isHealthy = false;
      // 不要在这里增加errorCount，因为这不是一个请求失败
      // errorCount应该只在recordRequest方法中增加
      this.metrics.set(serverName, metrics);
      this.updateQualityScore(serverName);
    }
  }

  markServerHealthy(serverName: string): void {
    const metrics = this.metrics.get(serverName);
    if (metrics) {
      metrics.isHealthy = true;
      this.metrics.set(serverName, metrics);
      this.updateQualityScore(serverName);
    }
  }

  updateCapabilityScore(serverName: string, score: number): void {
    const metrics = this.metrics.get(serverName);
    if (metrics) {
      metrics.capabilityScore = Math.max(0, Math.min(1, score));
      this.metrics.set(serverName, metrics);
      this.updateQualityScore(serverName);
    }
  }

  private updateQualityScore(serverName: string): void {
    const metrics = this.metrics.get(serverName);
    if (!metrics) return;

    // 计算各项评分
    const performanceScore = this.calculatePerformanceScore(metrics);
    const reliabilityScore = this.calculateReliabilityScore(metrics);
    const loadScore = this.calculateLoadScore(metrics);

    const qualityScore: MCPQualityScore = {
      serverName,
      overallScore: 0,
      performanceScore,
      reliabilityScore,
      capabilityScore: metrics.capabilityScore,
      loadScore,
      lastUpdated: new Date()
    };

    // 计算综合评分 (加权平均)
    qualityScore.overallScore = 
      performanceScore * 0.3 +
      reliabilityScore * 0.3 +
      metrics.capabilityScore * 0.2 +
      loadScore * 0.2;

    this.qualityScores.set(serverName, qualityScore);
  }

  private calculatePerformanceScore(metrics: MCPServerMetrics): number {
    // 基于响应时间计算性能评分
    // 响应时间越短，评分越高
    const maxResponseTime = 5000; // 5秒作为最大响应时间
    return Math.max(0, 1 - (metrics.responseTime / maxResponseTime));
  }

  private calculateReliabilityScore(metrics: MCPServerMetrics): number {
    // 基于成功率和健康状态计算可靠性评分
    if (!metrics.isHealthy) return 0;
    return metrics.successRate;
  }

  private calculateLoadScore(metrics: MCPServerMetrics): number {
    // 基于负载因子计算负载评分
    // 负载越低，评分越高
    return 1 - metrics.loadFactor;
  }

  getMetrics(serverName: string): MCPServerMetrics | undefined {
    return this.metrics.get(serverName);
  }

  getAllMetrics(): MCPServerMetrics[] {
    return Array.from(this.metrics.values());
  }

  getQualityScore(serverName: string): MCPQualityScore | undefined {
    return this.qualityScores.get(serverName);
  }

  getAllQualityScores(): MCPQualityScore[] {
    return Array.from(this.qualityScores.values());
  }

  getTopServers(count: number = 5): MCPQualityScore[] {
    return this.getAllQualityScores()
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(0, count);
  }

  getHealthyServers(): MCPServerMetrics[] {
    return this.getAllMetrics().filter(metrics => metrics.isHealthy);
  }

  private cleanupOldData(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24小时

    // 清理过期的指标数据
    for (const [serverName, metrics] of this.metrics.entries()) {
      if (now - metrics.lastUsed.getTime() > maxAge) {
        this.metrics.delete(serverName);
        this.qualityScores.delete(serverName);
      }
    }
  }

  getServerStats(): { totalServers: number; healthyServers: number; averageResponseTime: number } {
    const allMetrics = this.getAllMetrics();
    const healthyMetrics = allMetrics.filter(m => m.isHealthy);
    
    const averageResponseTime = healthyMetrics.length > 0
      ? healthyMetrics.reduce((sum, m) => sum + m.responseTime, 0) / healthyMetrics.length
      : 0;

    return {
      totalServers: allMetrics.length,
      healthyServers: healthyMetrics.length,
      averageResponseTime
    };
  }
} 