export interface MCPServerMetrics {
  serverName: string;
  responseTime: number; // 平均响应时间(ms)
  successRate: number; // 成功率(0-1)
  errorCount: number; // 错误次数
  totalRequests: number; // 总请求数
  lastUsed: Date; // 最后使用时间
  isHealthy: boolean; // 健康状态
  loadFactor: number; // 负载因子(0-1)
  capabilityScore: number; // 能力匹配度(0-1)
}

export interface MCPSelectionStrategy {
  name: string;
  description: string;
  selectServer: (
    request: any,
    availableServers: MCPServerMetrics[],
    toolToClientMap: Map<string, any>
  ) => string | null;
}

export interface MCPHealthCheck {
  serverName: string;
  isHealthy: boolean;
  lastCheck: Date;
  errorMessage?: string;
  responseTime?: number;
}

export interface MCPLoadBalancer {
  getNextServer: (servers: MCPServerMetrics[]) => string | null;
  updateMetrics: (serverName: string, metrics: Partial<MCPServerMetrics>) => void;
}

export interface MCPQualityScore {
  serverName: string;
  overallScore: number; // 综合评分(0-1)
  performanceScore: number; // 性能评分
  reliabilityScore: number; // 可靠性评分
  capabilityScore: number; // 能力匹配评分
  loadScore: number; // 负载评分
  lastUpdated: Date;
}

export interface MCPRequestContext {
  requestType: 'tool' | 'resource' | 'prompt';
  requestName: string;
  priority: 'high' | 'medium' | 'low';
  timeout?: number;
  retryCount?: number;
}

export interface MCPSelectionResult {
  selectedServer: string | null;
  confidence: number; // 选择置信度(0-1)
  reason: string;
  alternatives: string[];
  estimatedResponseTime: number;
  strategy: string; // 添加策略字段
} 