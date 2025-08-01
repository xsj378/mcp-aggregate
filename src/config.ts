import { readFile } from 'fs/promises';
import { resolve } from 'path';

export type TransportConfigStdio = {
  type?: 'stdio'
  command: string;
  args?: string[];
  env?: string[]
}

export type TransportConfigSSE = {
  type: 'sse'
  url: string
}

export type TransportConfig = TransportConfigSSE | TransportConfigStdio

export interface ServerConfig {
  name: string;
  transport: TransportConfig;
  priority?: number; // 服务器优先级 (1-10, 1为最高)
  capabilities?: string[]; // 服务器支持的能力
  maxConcurrentRequests?: number; // 最大并发请求数
}

export interface TimeoutConfig {
  toolsList: number; // 工具列表获取超时时间(ms)
  toolsCall: number; // 工具调用超时时间(ms)
  promptsGet: number; // 提示获取超时时间(ms)
  promptsList: number; // 提示列表获取超时时间(ms)
  resourcesList: number; // 资源列表获取超时时间(ms)
  resourcesRead: number; // 资源读取超时时间(ms)
  resourceTemplatesList: number; // 资源模板列表获取超时时间(ms)
  reinitialize: number; // 重新初始化超时时间(ms)
  reconnectDelay: number; // 重连延迟时间(ms)
}

export interface SelectionStrategyConfig {
  default: 'adaptive' | 'quality' | 'performance' | 'load-balanced' | 'round-robin';
  fallback: 'adaptive' | 'quality' | 'performance' | 'load-balanced' | 'round-robin';
  timeout: number; // 请求超时时间(ms)
  maxRetries: number; // 最大重试次数
  healthCheckInterval: number; // 健康检查间隔(ms)
  timeouts?: TimeoutConfig; // 详细超时配置
}

export interface MonitoringConfig {
  enabled: boolean;
  metricsRetentionHours: number; // 指标保留时间(小时)
  alertThresholds: {
    responseTime: number; // 响应时间阈值(ms)
    errorRate: number; // 错误率阈值(0-1)
    unhealthyServers: number; // 不健康服务器比例阈值(0-1)
  };
}

export interface Config {
  servers: ServerConfig[];
  selectionStrategy?: SelectionStrategyConfig;
  monitoring?: MonitoringConfig;
}

export const loadConfig = async (): Promise<Config> => {
  try {
    const configPath = resolve(process.cwd(), 'config.json');
    const fileContents = await readFile(configPath, 'utf-8');
    const config = JSON.parse(fileContents);
    
    // 设置默认值
    return {
      servers: config.servers || [],
      selectionStrategy: {
        default: 'adaptive',
        fallback: 'quality',
        timeout: 5000,
        maxRetries: 2,
        healthCheckInterval: 30000,
        timeouts: {
          toolsList: 15000,
          toolsCall: 30000,
          promptsGet: 15000,
          promptsList: 10000,
          resourcesList: 10000,
          resourcesRead: 15000,
          resourceTemplatesList: 10000,
          reinitialize: 30000,
          reconnectDelay: 3000
        },
        ...config.selectionStrategy
      },
      monitoring: {
        enabled: true,
        metricsRetentionHours: 24,
        alertThresholds: {
          responseTime: 5000,
          errorRate: 0.1,
          unhealthyServers: 0.5
        },
        ...config.monitoring
      }
    };
  } catch (error) {
    console.error('Error loading config.json:', error);
    // Return default config if file doesn't exist
    return {
      servers: [],
      selectionStrategy: {
        default: 'adaptive',
        fallback: 'quality',
        timeout: 5000,
        maxRetries: 2,
        healthCheckInterval: 30000,
        timeouts: {
          toolsList: 15000,
          toolsCall: 30000,
          promptsGet: 15000,
          promptsList: 10000,
          resourcesList: 10000,
          resourcesRead: 15000,
          resourceTemplatesList: 10000,
          reinitialize: 30000,
          reconnectDelay: 3000
        }
      },
      monitoring: {
        enabled: true,
        metricsRetentionHours: 24,
        alertThresholds: {
          responseTime: 5000,
          errorRate: 0.1,
          unhealthyServers: 0.5
        }
      }
    };
  }
}; 