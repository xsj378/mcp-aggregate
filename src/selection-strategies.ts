import { MCPSelectionStrategy, MCPServerMetrics, MCPRequestContext, MCPSelectionResult } from './types.js';

// 基于质量评分的选择策略
export class QualityBasedStrategy implements MCPSelectionStrategy {
  name = 'Quality-Based Selection';
  description = '选择综合质量评分最高的服务器';

  selectServer(
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ): string | null {
    if (availableServers.length === 0) return null;

    // 按综合评分排序
    const sortedServers = availableServers
      .filter(server => server.isHealthy)
      .sort((a, b) => {
        const scoreA = this.calculateOverallScore(a);
        const scoreB = this.calculateOverallScore(b);
        return scoreB - scoreA;
      });

    return sortedServers[0]?.serverName || null;
  }

  private calculateOverallScore(metrics: MCPServerMetrics): number {
    const performanceScore = Math.max(0, 1 - (metrics.responseTime / 5000));
    const reliabilityScore = metrics.successRate;
    const loadScore = 1 - metrics.loadFactor;
    
    return (
      performanceScore * 0.3 +
      reliabilityScore * 0.3 +
      metrics.capabilityScore * 0.2 +
      loadScore * 0.2
    );
  }
}

// 基于响应时间的选择策略
export class PerformanceBasedStrategy implements MCPSelectionStrategy {
  name = 'Performance-Based Selection';
  description = '选择响应时间最短的服务器';

  selectServer(
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ): string | null {
    if (availableServers.length === 0) return null;

    const healthyServers = availableServers.filter(server => server.isHealthy);
    if (healthyServers.length === 0) return null;

    // 选择响应时间最短的服务器
    const fastestServer = healthyServers.reduce((fastest, current) =>
      current.responseTime < fastest.responseTime ? current : fastest
    );

    return fastestServer.serverName;
  }
}

// 基于负载均衡的选择策略
export class LoadBalancedStrategy implements MCPSelectionStrategy {
  name = 'Load-Balanced Selection';
  description = '选择负载最低的服务器';

  selectServer(
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ): string | null {
    if (availableServers.length === 0) return null;

    const healthyServers = availableServers.filter(server => server.isHealthy);
    if (healthyServers.length === 0) return null;

    // 选择负载最低的服务器
    const leastLoadedServer = healthyServers.reduce((least, current) =>
      current.loadFactor < least.loadFactor ? current : least
    );

    return leastLoadedServer.serverName;
  }
}

// 轮询选择策略
export class RoundRobinStrategy implements MCPSelectionStrategy {
  name = 'Round-Robin Selection';
  description = '轮询选择服务器';

  private currentIndex = 0;

  selectServer(
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ): string | null {
    if (availableServers.length === 0) return null;

    const healthyServers = availableServers.filter(server => server.isHealthy);
    if (healthyServers.length === 0) return null;

    const selectedServer = healthyServers[this.currentIndex % healthyServers.length];
    this.currentIndex = (this.currentIndex + 1) % healthyServers.length;

    return selectedServer.serverName;
  }
}

// 自适应选择策略
export class AdaptiveStrategy implements MCPSelectionStrategy {
  name = 'Adaptive Selection';
  description = '根据请求类型和服务器特性自适应选择';

  selectServer(
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ): string | null {
    if (availableServers.length === 0) return null;

    const healthyServers = availableServers.filter(server => server.isHealthy);
    if (healthyServers.length === 0) return null;

    // 根据请求类型选择策略
    const requestType = this.detectRequestType(request);
    
    switch (requestType) {
      case 'performance-critical':
        // 性能关键型请求：选择响应时间最短的
        return this.selectByPerformance(healthyServers);
      case 'reliability-critical':
        // 可靠性关键型请求：选择成功率最高的
        return this.selectByReliability(healthyServers);
      case 'balanced':
      default:
        // 平衡型请求：选择综合评分最高的
        return this.selectByOverallScore(healthyServers);
    }
  }

  private detectRequestType(request: any): 'performance-critical' | 'reliability-critical' | 'balanced' {
    // 根据请求特征判断类型
    if (request.params?.timeout && request.params.timeout < 1000) {
      return 'performance-critical';
    }
    
    if (request.params?.priority === 'high') {
      return 'reliability-critical';
    }

    return 'balanced';
  }

  private selectByPerformance(servers: MCPServerMetrics[]): string | null {
    const fastest = servers.reduce((fastest, current) =>
      current.responseTime < fastest.responseTime ? current : fastest
    );
    return fastest.serverName;
  }

  private selectByReliability(servers: MCPServerMetrics[]): string | null {
    const mostReliable = servers.reduce((most, current) =>
      current.successRate > most.successRate ? current : most
    );
    return mostReliable.serverName;
  }

  private selectByOverallScore(servers: MCPServerMetrics[]): string | null {
    const best = servers.reduce((best, current) => {
      const scoreA = this.calculateOverallScore(best);
      const scoreB = this.calculateOverallScore(current);
      return scoreB > scoreA ? current : best;
    });
    return best.serverName;
  }

  private calculateOverallScore(metrics: MCPServerMetrics): number {
    const performanceScore = Math.max(0, 1 - (metrics.responseTime / 5000));
    const reliabilityScore = metrics.successRate;
    const loadScore = 1 - metrics.loadFactor;
    
    return (
      performanceScore * 0.3 +
      reliabilityScore * 0.3 +
      metrics.capabilityScore * 0.2 +
      loadScore * 0.2
    );
  }
}

// 智能选择器
export class SmartSelector {
  private strategies: Map<string, MCPSelectionStrategy> = new Map();
  private defaultStrategy: MCPSelectionStrategy;

  constructor() {
    // 注册所有策略
    this.strategies.set('quality', new QualityBasedStrategy());
    this.strategies.set('performance', new PerformanceBasedStrategy());
    this.strategies.set('load-balanced', new LoadBalancedStrategy());
    this.strategies.set('round-robin', new RoundRobinStrategy());
    this.strategies.set('adaptive', new AdaptiveStrategy());

    this.defaultStrategy = new AdaptiveStrategy();
  }

  selectServer(
    strategyName: string,
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ): MCPSelectionResult {
    const strategy = this.strategies.get(strategyName) || this.defaultStrategy;
    const selectedServer = strategy.selectServer(request, availableServers, toolToClientMap);

    if (!selectedServer) {
      return {
        selectedServer: null,
        confidence: 0,
        reason: 'No healthy servers available',
        alternatives: [],
        estimatedResponseTime: 0,
        strategy: strategy.name
      };
    }

    const serverMetrics = availableServers.find(s => s.serverName === selectedServer);
    const confidence = this.calculateConfidence(serverMetrics, availableServers);
    const alternatives = this.getAlternatives(selectedServer, availableServers);

    return {
      selectedServer,
      confidence,
      reason: `Selected using ${strategy.name}: ${strategy.description}`,
      alternatives,
      estimatedResponseTime: serverMetrics?.responseTime || 0,
      strategy: strategy.name
    };
  }

  private calculateConfidence(
    selectedMetrics: MCPServerMetrics | undefined,
    allServers: MCPServerMetrics[]
  ): number {
    if (!selectedMetrics) return 0;

    const healthyServers = allServers.filter(s => s.isHealthy);
    if (healthyServers.length === 0) return 0;

    // 基于服务器在健康服务器中的排名计算置信度
    const sortedServers = healthyServers.sort((a, b) => {
      const scoreA = this.calculateOverallScore(a);
      const scoreB = this.calculateOverallScore(b);
      return scoreB - scoreA;
    });

    const rank = sortedServers.findIndex(s => s.serverName === selectedMetrics.serverName);
    return Math.max(0, 1 - (rank / healthyServers.length));
  }

  private getAlternatives(
    selectedServer: string,
    availableServers: MCPServerMetrics[]
  ): string[] {
    const healthyServers = availableServers
      .filter(s => s.isHealthy && s.serverName !== selectedServer)
      .sort((a, b) => {
        const scoreA = this.calculateOverallScore(a);
        const scoreB = this.calculateOverallScore(b);
        return scoreB - scoreA;
      });

    return healthyServers.slice(0, 3).map(s => s.serverName);
  }

  private calculateOverallScore(metrics: MCPServerMetrics): number {
    const performanceScore = Math.max(0, 1 - (metrics.responseTime / 5000));
    const reliabilityScore = metrics.successRate;
    const loadScore = 1 - metrics.loadFactor;
    
    return (
      performanceScore * 0.3 +
      reliabilityScore * 0.3 +
      metrics.capabilityScore * 0.2 +
      loadScore * 0.2
    );
  }

  getAvailableStrategies(): Array<{ name: string; description: string }> {
    return Array.from(this.strategies.values()).map(strategy => ({
      name: strategy.name,
      description: strategy.description
    }));
  }
} 