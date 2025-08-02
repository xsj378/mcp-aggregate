import { ConnectedClient } from './client.js';
import { MetricsManager } from './metrics-manager.js';
import { MCPHealthCheck } from './types.js';
import {
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  CompatibilityCallToolResultSchema
} from "@modelcontextprotocol/sdk/types.js";

// 功能测试配置
interface FunctionalTestConfig {
  testIntervalMs: number; // 测试间隔
  timeoutMs: number; // 测试超时时间
  maxRetries: number; // 最大重试次数
  enableToolsTest: boolean; // 是否测试工具功能
  enablePromptsTest: boolean; // 是否测试提示功能
  enableResourcesTest: boolean; // 是否测试资源功能
}

// 功能测试结果
interface FunctionalTestResult {
  serverName: string;
  timestamp: Date;
  isHealthy: boolean;
  errorMessage?: string;
  responseTime: number;
  tests: {
    tools?: TestResult;
    prompts?: TestResult;
    resources?: TestResult;
  };
}

interface TestResult {
  success: boolean;
  responseTime: number;
  errorMessage?: string;
  details?: any;
}

export class FunctionalHealthMonitor {
  private testResults: Map<string, FunctionalTestResult> = new Map();
  private metricsManager: MetricsManager;
  private testInterval: NodeJS.Timeout | null = null;
  private config: FunctionalTestConfig;

  constructor(
    metricsManager: MetricsManager,
    config: Partial<FunctionalTestConfig> = {}
  ) {
    this.metricsManager = metricsManager;
    this.config = {
      testIntervalMs: 300000, // 5分钟测试一次
      timeoutMs: 10000, // 10秒超时
      maxRetries: 2,
      enableToolsTest: true,
      enablePromptsTest: false,
      enableResourcesTest: false,
      ...config
    };
  }

  startMonitoring(connectedClients: ConnectedClient[]): void {
    console.log(`🚀 功能健康监控启动，测试间隔: ${this.config.testIntervalMs / 1000}秒`);
    
    // 立即执行一次测试
    this.performFunctionalTests(connectedClients);
    
    // 开始定期测试
    this.testInterval = setInterval(() => {
      this.performFunctionalTests(connectedClients);
    }, this.config.testIntervalMs);
  }

  stopMonitoring(): void {
    if (this.testInterval) {
      clearInterval(this.testInterval);
      this.testInterval = null;
      console.log('🛑 功能健康监控已停止');
    }
  }

  private async performFunctionalTests(connectedClients: ConnectedClient[]): Promise<void> {
    console.log(`🔍 开始功能健康检查，共 ${connectedClients.length} 个服务器`);
    
    const testPromises = connectedClients.map(async (client) => {
      try {
        const result = await this.testServerFunctionality(client);
        this.testResults.set(client.name, result);
        
        // 更新指标管理器
        if (result.isHealthy) {
          this.metricsManager.markServerHealthy(client.name);
        } else {
          this.metricsManager.markServerUnhealthy(client.name, result.errorMessage);
        }
        
        console.log(`✅ ${client.name} 功能测试完成: ${result.isHealthy ? '健康' : '不健康'}`);
      } catch (error) {
        console.error(`❌ ${client.name} 功能测试失败:`, error);
      }
    });

    await Promise.allSettled(testPromises);
    console.log('🏁 所有服务器功能测试完成');
  }

  private async testServerFunctionality(client: ConnectedClient): Promise<FunctionalTestResult> {
    const startTime = Date.now();
    const tests: FunctionalTestResult['tests'] = {};
    let isHealthy = true;
    let errorMessage: string | undefined;

    try {
      // 测试工具功能
      if (this.config.enableToolsTest) {
        tests.tools = await this.testToolsFunctionality(client);
        if (!tests.tools.success) {
          isHealthy = false;
          errorMessage = `工具测试失败: ${tests.tools.errorMessage}`;
        }
      }

      // 测试提示功能
      if (this.config.enablePromptsTest && isHealthy) {
        tests.prompts = await this.testPromptsFunctionality(client);
        if (!tests.prompts.success) {
          isHealthy = false;
          errorMessage = `提示测试失败: ${tests.prompts.errorMessage}`;
        }
      }

      // 测试资源功能
      if (this.config.enableResourcesTest && isHealthy) {
        tests.resources = await this.testResourcesFunctionality(client);
        if (!tests.resources.success) {
          isHealthy = false;
          errorMessage = `资源测试失败: ${tests.resources.errorMessage}`;
        }
      }

    } catch (error) {
      isHealthy = false;
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
    }

    const responseTime = Date.now() - startTime;

    return {
      serverName: client.name,
      timestamp: new Date(),
      isHealthy,
      errorMessage,
      responseTime,
      tests
    };
  }

  private async testToolsFunctionality(client: ConnectedClient): Promise<TestResult> {
    const startTime = Date.now();
    
    try {
      // 测试1: 获取工具列表
      const toolsResult = await this.executeWithTimeout(
        client.client.request(
          {
            method: 'tools/list',
            params: { _meta: {} }
          },
          ListToolsResultSchema
        ),
        this.config.timeoutMs
      ) as any;

      if (!toolsResult.tools || toolsResult.tools.length === 0) {
        return {
          success: false,
          responseTime: Date.now() - startTime,
          errorMessage: '没有可用的工具'
        };
      }

      // 测试2: 尝试调用第一个工具（如果可能）
      const firstTool = toolsResult.tools[0];
      if (firstTool && firstTool.name) {
        try {
          // 尝试调用工具，但不关心结果
          await this.executeWithTimeout(
            client.client.request(
              {
                method: 'tools/call',
                params: {
                  name: firstTool.name,
                  arguments: {},
                  _meta: {}
                }
              },
              CompatibilityCallToolResultSchema
            ),
            this.config.timeoutMs
          );
        } catch (toolError) {
          // 工具调用失败是正常的，只要不是连接错误就认为工具功能正常
          const errorMessage = toolError instanceof Error ? toolError.message : 'Unknown error';
          if (!errorMessage.includes('Connection') && !errorMessage.includes('timeout')) {
            // 业务错误是正常的，说明工具功能正常
            return {
              success: true,
              responseTime: Date.now() - startTime,
              details: { toolsCount: toolsResult.tools.length, testedTool: firstTool.name }
            };
          } else {
            return {
              success: false,
              responseTime: Date.now() - startTime,
              errorMessage: `工具调用失败: ${errorMessage}`
            };
          }
        }
      }

      return {
        success: true,
        responseTime: Date.now() - startTime,
        details: { toolsCount: toolsResult.tools.length }
      };

    } catch (error) {
      return {
        success: false,
        responseTime: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async testPromptsFunctionality(client: ConnectedClient): Promise<TestResult> {
    const startTime = Date.now();
    
    try {
      // 测试获取提示列表
      const promptsResult = await this.executeWithTimeout(
        client.client.request(
          {
            method: 'prompts/list',
            params: { _meta: {} }
          },
          ListPromptsResultSchema
        ),
        this.config.timeoutMs
      ) as any;

      return {
        success: true,
        responseTime: Date.now() - startTime,
        details: { promptsCount: promptsResult.prompts?.length || 0 }
      };

    } catch (error) {
      return {
        success: false,
        responseTime: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async testResourcesFunctionality(client: ConnectedClient): Promise<TestResult> {
    const startTime = Date.now();
    
    try {
      // 测试获取资源列表
      const resourcesResult = await this.executeWithTimeout(
        client.client.request(
          {
            method: 'resources/list',
            params: { _meta: {} }
          },
          ListResourcesResultSchema
        ),
        this.config.timeoutMs
      ) as any;

      return {
        success: true,
        responseTime: Date.now() - startTime,
        details: { resourcesCount: resourcesResult.resources?.length || 0 }
      };

    } catch (error) {
      return {
        success: false,
        responseTime: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  // 手动触发功能测试
  async triggerFunctionalTest(client: ConnectedClient): Promise<FunctionalTestResult> {
    console.log(`🔍 手动触发 ${client.name} 功能测试`);
    const result = await this.testServerFunctionality(client);
    this.testResults.set(client.name, result);
    return result;
  }

  // 获取功能测试结果
  getFunctionalTestResult(serverName: string): FunctionalTestResult | undefined {
    return this.testResults.get(serverName);
  }

  // 获取所有功能测试结果
  getAllFunctionalTestResults(): FunctionalTestResult[] {
    return Array.from(this.testResults.values());
  }

  // 获取功能健康摘要
  getFunctionalHealthSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    averageResponseTime: number;
  } {
    const results = this.getAllFunctionalTestResults();
    const healthy = results.filter(r => r.isHealthy).length;
    
    const averageResponseTime = results.length > 0
      ? results.reduce((sum, r) => sum + r.responseTime, 0) / results.length
      : 0;

    return {
      total: results.length,
      healthy,
      unhealthy: results.length - healthy,
      averageResponseTime
    };
  }

  // 更新配置
  updateConfig(newConfig: Partial<FunctionalTestConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('⚙️ 功能健康监控配置已更新:', this.config);
  }
} 