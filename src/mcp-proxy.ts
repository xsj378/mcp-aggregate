import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ResourceTemplate,
  CompatibilityCallToolResultSchema,
  GetPromptResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import { createClients, ConnectedClient } from './client.js';
import { Config, loadConfig } from './config.js';
import { MetricsManager } from './metrics-manager.js';
import { SmartSelector } from './selection-strategies.js';
import { HealthMonitor } from './health-monitor.js';
import { MCPSelectionResult } from './types.js';
import { z } from 'zod';
import * as eventsource from 'eventsource';

global.EventSource = eventsource.EventSource

export const createServer = async () => {
  // Load configuration and connect to servers
  const config = await loadConfig();
  const connectedClients = await createClients(config.servers);
  console.log(`Connected to ${connectedClients.length} servers`);

  // Initialize smart selection components
  const metricsManager = new MetricsManager();
  const smartSelector = new SmartSelector();
  const healthMonitor = new HealthMonitor(metricsManager);

  // Initialize metrics for all connected clients
  for (const client of connectedClients) {
    metricsManager.initializeServer(client.name);
  }

  // Start health monitoring
  healthMonitor.startMonitoring(connectedClients);

  // Maps to track which client owns which resource
  const toolToClientMap = new Map<string, ConnectedClient>();
  const resourceToClientMap = new Map<string, ConnectedClient>();
  const promptToClientMap = new Map<string, ConnectedClient>();

  // Track consecutive failures for each server
  const failureCounts = new Map<string, number>();

  const server = new Server(
    {
      name: "mcp-proxy-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
      },
    },
  );

  // Helper function to get only healthy clients with better error isolation
  const getHealthyClients = (): ConnectedClient[] => {
    return connectedClients.filter(client => {
      // 更宽松的健康检查：只要连接存在就认为可用
      // 即使健康检查失败，也允许服务器继续工作
      return client.isConnected;
    });
  };

  // Helper function to get truly healthy clients (for strict operations)
  const getStrictlyHealthyClients = (): ConnectedClient[] => {
    return connectedClients.filter(client => {
      const healthStatus = healthMonitor.getHealthStatus(client.name);
      return client.isConnected && healthStatus?.isHealthy;
    });
  };

  // Helper function to remove unhealthy servers
  const removeUnhealthyServer = (serverName: string): void => {
    const index = connectedClients.findIndex(client => client.name === serverName);
    if (index !== -1) {
      const removedClient = connectedClients[index];
      console.log(`🚫 移除不健康的服务器: ${serverName}`);
      
      // 清理相关的映射
      for (const [toolName, client] of toolToClientMap.entries()) {
        if (client.name === serverName) {
          toolToClientMap.delete(toolName);
        }
      }
      
      for (const [resourceUri, client] of resourceToClientMap.entries()) {
        if (client.name === serverName) {
          resourceToClientMap.delete(resourceUri);
        }
      }
      
      for (const [promptName, client] of promptToClientMap.entries()) {
        if (client.name === serverName) {
          promptToClientMap.delete(promptName);
        }
      }
      
      // 从连接列表中移除
      connectedClients.splice(index, 1);
      
      // 清理失败计数
      failureCounts.delete(serverName);
      
      console.log(`✅ 服务器 ${serverName} 已移除，剩余服务器数量: ${connectedClients.length}`);
    }
  };

  // Helper function to check and remove unhealthy servers
  const checkAndRemoveUnhealthyServers = (): void => {
    const unhealthyServers = connectedClients.filter(client => {
      const healthStatus = healthMonitor.getHealthStatus(client.name);
      return !client.isConnected || !healthStatus?.isHealthy;
    });

    unhealthyServers.forEach(server => {
      removeUnhealthyServer(server.name);
    });
  };

  // Helper function to select the best server for a request
  const selectBestServer = (
    request: any,
    availableClients: ConnectedClient[],
    strategy: string = 'adaptive'
  ): MCPSelectionResult => {
    // 使用更宽松的健康检查：只要连接存在就认为可用
    const healthyClients = availableClients.filter(client => {
      return client.isConnected;
    });

    if (healthyClients.length === 0) {
      return {
        selectedServer: null,
        reason: 'No connected servers available',
        strategy,
        confidence: 0,
        alternatives: [],
        estimatedResponseTime: 0
      };
    }

    const availableMetrics = healthyClients
      .map(client => metricsManager.getMetrics(client.name))
      .filter(metrics => metrics !== undefined) as any[];

    return smartSelector.selectServer(strategy, request, availableMetrics, toolToClientMap);
  };

  // Helper function to execute request with retry and fallback
  const executeWithRetry = async (
    request: any,
    client: ConnectedClient,
    operation: (client: ConnectedClient) => Promise<any>,
    maxRetries: number = 2
  ): Promise<any> => {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      
      try {
        const result = await operation(client);
        const responseTime = Date.now() - startTime;
        
        // 指标已经在工具调用层记录，这里只处理重试逻辑
        console.log(`✅ executeWithRetry SUCCESS for ${client.name}: ${responseTime}ms`);
        failureCounts.set(client.name, 0); // Reset failure count
        
        return result;
      } catch (error) {
        const responseTime = Date.now() - startTime;
        lastError = error as Error;
        
        // 指标已经在工具调用层记录，这里只处理重试逻辑
        console.log(`❌ executeWithRetry FAILURE for ${client.name}: ${responseTime}ms, error: ${lastError.message}`);
        
        // 检查错误类型，某些错误不应该导致服务器被标记为不健康
        const errorMessage = lastError.message;
        const isToolNotFound = errorMessage.includes('Tool') && errorMessage.includes('not found');
        const isInvalidParams = errorMessage.includes('Invalid parameters');
        const isRobotsTxtError = errorMessage.includes('robots.txt') || errorMessage.includes('robots');
        const isBusinessError = isToolNotFound || isInvalidParams || isRobotsTxtError;
        const isConnectionError = errorMessage.includes('Connection') || 
                                errorMessage.includes('timeout') || 
                                errorMessage.includes('ECONNREFUSED') ||
                                errorMessage.includes('ENOTFOUND');
        
        // 只有连接错误才增加失败计数
        if (isConnectionError) {
          const currentFailures = failureCounts.get(client.name) || 0;
          failureCounts.set(client.name, currentFailures + 1);
          
          // 检查是否应该标记为不健康
          if (healthMonitor.shouldMarkUnhealthy(client.name, currentFailures + 1)) {
            metricsManager.markServerUnhealthy(client.name, lastError.message);
            if (currentFailures + 1 >= 5) {
              console.warn(`服务器 ${client.name} 连续连接失败 ${currentFailures + 1} 次`);
            }
          }
        } else {
          // 对于业务错误，不增加失败计数，只记录日志
          console.warn(`服务器 ${client.name} 返回业务错误: ${errorMessage}`);
          if (isToolNotFound) {
            console.info(`工具不存在错误，服务器 ${client.name} 可能不支持此功能`);
          } else if (isInvalidParams) {
            console.info(`参数错误，服务器 ${client.name} 可能需要不同的参数格式`);
          } else if (isRobotsTxtError) {
            console.info(`robots.txt 错误，目标网站禁止抓取`);
          }
        }
        
        console.warn(`Attempt ${attempt + 1} failed for ${client.name}:`, lastError.message);
        
        if (attempt === maxRetries) {
          break;
        }
        
        // 只有连接错误才重试
        if (!isConnectionError) {
          console.log(`非连接错误，跳过重试: ${errorMessage}`);
          break;
        }
        
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
    
    throw lastError;
  };

  // List Tools Handler with improved error isolation
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const allTools: Tool[] = [];
    toolToClientMap.clear();

    // 只使用健康的服务器
    const healthyClients = getHealthyClients();
    
    if (healthyClients.length === 0) {
      console.warn('No healthy servers available for tools/list');
      return { tools: allTools };
    }

    // 使用 Promise.allSettled 确保一个服务器的失败不会影响其他服务器
    const toolPromises = healthyClients.map(async (connectedClient) => {
      try {
        const result = await executeWithRetry(
          request,
          connectedClient,
          async (client) => {
            // 添加超时保护
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timeout')), 10000); // 10秒超时
            });
            
            const requestPromise = client.client.request(
              {
                method: 'tools/list',
                params: {
                  _meta: request.params?._meta
                }
              },
              ListToolsResultSchema
            );
            
            return Promise.race([requestPromise, timeoutPromise]);
          }
        );

        if (result.tools) {
          const toolsWithSource = result.tools.map((tool: any) => {
            toolToClientMap.set(tool.name, connectedClient);
            return {
              ...tool,
              description: `[${connectedClient.name}] ${tool.description || ''}`
            };
          });
          return toolsWithSource;
        }
        return [];
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error fetching tools from ${connectedClient.name}:`, errorMessage);
        
        // 检查错误类型
        const isConnectionError = errorMessage.includes('Connection') || 
                                errorMessage.includes('timeout') || 
                                errorMessage.includes('ECONNREFUSED') ||
                                errorMessage.includes('ENOTFOUND');
        
        // 只有连接错误才标记为不连接
        if (isConnectionError) {
          connectedClient.isConnected = false;
          connectedClient.lastError = errorMessage;
          
          // 更新健康状态
          try {
            healthMonitor.triggerHealthCheck(connectedClient);
          } catch (healthError) {
            console.error(`Failed to update health status for ${connectedClient.name}:`, healthError);
          }
        } else {
          // 对于其他错误（如工具不存在），只记录日志，不改变连接状态
          console.warn(`服务器 ${connectedClient.name} 工具列表获取失败: ${errorMessage}`);
        }
        
        return []; // 返回空数组，不影响其他服务器
      }
    });

    const results = await Promise.allSettled(toolPromises);
    
    // 收集所有成功的结果
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allTools.push(...result.value);
      } else {
        console.error(`Failed to fetch tools from ${healthyClients[index].name}:`, result.reason);
        // 不抛出错误，继续处理其他服务器
      }
    });

    // 即使所有服务器都失败，也返回空结果而不是抛出错误
    console.log(`Successfully collected tools from ${allTools.length} total tools across all servers`);
    
    // 打印工具映射信息，帮助调试
    console.log('📋 Current tool mapping:');
    for (const [toolName, client] of toolToClientMap.entries()) {
      console.log(`  ${toolName} -> ${client.name}`);
    }
    
    return { tools: allTools };
  });

  // Call Tool Handler with improved error handling
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    // 首先尝试从映射中找到工具所属的服务器
    let clientForTool = toolToClientMap.get(name);
    
    if (!clientForTool) {
      // 如果工具不在映射中，尝试重新获取工具列表来重建映射
      console.log(`Tool '${name}' not found in mapping, attempting to rebuild tool mapping...`);
      
      try {
        // 重新获取工具列表
        const allTools: Tool[] = [];
        toolToClientMap.clear();
        
        const healthyClients = getHealthyClients();
        const toolPromises = healthyClients.map(async (connectedClient) => {
          try {
            const result = await executeWithRetry(
              request,
              connectedClient,
              async (client) => {
                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('Request timeout')), 10000);
                });
                
                const requestPromise = client.client.request(
                  {
                    method: 'tools/list',
                    params: { _meta: request.params?._meta }
                  },
                  ListToolsResultSchema
                );
                
                return Promise.race([requestPromise, timeoutPromise]);
              }
            );

            if (result.tools) {
              result.tools.forEach((tool: any) => {
                toolToClientMap.set(tool.name, connectedClient);
              });
              return result.tools;
            }
            return [];
          } catch (error) {
            console.warn(`Failed to get tools from ${connectedClient.name}:`, error);
            return [];
          }
        });

        await Promise.allSettled(toolPromises);
        
        // 重新尝试获取工具映射
        clientForTool = toolToClientMap.get(name);
        
        if (clientForTool) {
          console.log(`✅ Successfully rebuilt tool mapping, found '${name}' in ${clientForTool.name}`);
        } else {
          console.warn(`❌ Tool '${name}' not found in any server after rebuilding mapping`);
        }
      } catch (error) {
        console.error(`Failed to rebuild tool mapping:`, error);
      }
    }

    if (!clientForTool) {
      throw new Error(`Tool '${name}' is not available on any connected server. Please check if the tool exists and the server is running.`);
    }

    try {
      console.log(`Forwarding tool call '${name}' to ${clientForTool.name}`);

      const result = await executeWithRetry(
        request,
        clientForTool,
        async (client) => {
          const startTime = Date.now();
          
          try {
            // 添加超时保护
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timeout')), 60000); // 60秒超时
            });
            
            const requestPromise = client.client.request(
              {
                method: 'tools/call',
                params: {
                  name,
                  arguments: args || {},
                  _meta: {
                    progressToken: request.params._meta?.progressToken
                  }
                }
              },
              CompatibilityCallToolResultSchema
            );
            
            const result = await Promise.race([requestPromise, timeoutPromise]);
            const responseTime = Date.now() - startTime;
            
            // 直接在这里记录成功
            console.log(`📊 Direct SUCCESS recording for ${client.name}: ${responseTime}ms`);
            metricsManager.recordRequest(client.name, responseTime, true);
            
            return result;
          } catch (error) {
            const responseTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            
            // 直接在这里记录失败
            console.log(`📊 Direct FAILURE recording for ${client.name}: ${responseTime}ms, error: ${errorMessage}`);
            metricsManager.recordRequest(client.name, responseTime, false);
            
            // 重新抛出错误，让外层的 executeWithRetry 处理
            throw error;
          }
        },
        1 // 减少重试次数到1次
      );
      
      console.log(`✅ Tool '${name}' call successful through ${clientForTool.name}`);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Error calling tool '${name}' through ${clientForTool.name}:`, errorMessage);
      
      // 检查是否是工具不存在错误
      const isToolNotFound = errorMessage.includes('Tool') && errorMessage.includes('not found');
      
      if (isToolNotFound) {
        // 如果是工具不存在错误，从映射中移除该工具
        console.warn(`Tool '${name}' not found in ${clientForTool.name}, removing from mapping`);
        toolToClientMap.delete(name);
        
        // 抛出明确的错误，让客户端知道工具不存在
        throw new Error(`Tool '${name}' is not supported by server ${clientForTool.name}`);
      }
      
      // 对于其他类型的错误，按原来的逻辑处理
      const isConnectionError = errorMessage.includes('Connection') || 
                              errorMessage.includes('timeout') || 
                              errorMessage.includes('ECONNREFUSED') ||
                              errorMessage.includes('ENOTFOUND');
      
      if (isConnectionError) {
        // 只有连接错误才标记为不连接
        clientForTool.isConnected = false;
        clientForTool.lastError = errorMessage;
        
        // 更新健康状态
        try {
          healthMonitor.triggerHealthCheck(clientForTool);
        } catch (healthError) {
          console.error(`Failed to update health status for ${clientForTool.name}:`, healthError);
        }
      }
      
      throw error; // 重新抛出错误
    }
  });

  // Get Prompt Handler with improved error handling
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    let clientForPrompt = promptToClientMap.get(name);

    if (!clientForPrompt) {
      // 如果prompt不在映射中，尝试重新获取prompt列表来重建映射
      console.log(`Prompt '${name}' not found in mapping, attempting to rebuild prompt mapping...`);
      
      try {
        promptToClientMap.clear();
        
        const healthyClients = getHealthyClients();
        const promptPromises = healthyClients.map(async (connectedClient) => {
          try {
            const result = await executeWithRetry(
              request,
              connectedClient,
              async (client) => {
                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('Request timeout')), 10000);
                });
                
                const requestPromise = client.client.request(
                  {
                    method: 'prompts/list' as const,
                    params: {
                      cursor: request.params?.cursor,
                      _meta: request.params?._meta || { progressToken: undefined }
                    }
                  },
                  ListPromptsResultSchema
                );
                
                return Promise.race([requestPromise, timeoutPromise]);
              }
            );

            if (result.prompts) {
              result.prompts.forEach((prompt: any) => {
                promptToClientMap.set(prompt.name, connectedClient);
              });
              return result.prompts;
            }
            return [];
          } catch (error) {
            console.warn(`Failed to get prompts from ${connectedClient.name}:`, error);
            return [];
          }
        });

        await Promise.allSettled(promptPromises);
        
        // 重新尝试获取prompt映射
        clientForPrompt = promptToClientMap.get(name);
        
        if (clientForPrompt) {
          console.log(`✅ Successfully rebuilt prompt mapping, found '${name}' in ${clientForPrompt.name}`);
        } else {
          console.warn(`❌ Prompt '${name}' not found in any server after rebuilding mapping`);
        }
      } catch (error) {
        console.error(`Failed to rebuild prompt mapping:`, error);
      }
    }

    if (!clientForPrompt) {
      throw new Error(`Prompt '${name}' is not available on any connected server. Please check if the prompt exists and the server is running.`);
    }

    try {
      console.log(`Forwarding prompt request '${name}' to ${clientForPrompt.name}`);

      return await executeWithRetry(
        request,
        clientForPrompt,
        async (client) => {
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 15000); // 15秒超时
          });
          
                      const requestPromise = client.client.request(
              {
                method: 'prompts/get' as const,
                params: {
                  name,
                  arguments: request.params.arguments || {},
                  _meta: request.params._meta || {
                    progressToken: undefined
                  }
                }
              },
              GetPromptResultSchema
            );
          
          return Promise.race([requestPromise, timeoutPromise]);
        }
      );
    } catch (error) {
      console.error(`Error getting prompt from ${clientForPrompt.name}:`, error);
      
      // 标记客户端为不连接状态
      clientForPrompt.isConnected = false;
      clientForPrompt.lastError = error instanceof Error ? error.message : 'Unknown error';
      
      // 更新健康状态
      try {
        healthMonitor.triggerHealthCheck(clientForPrompt);
      } catch (healthError) {
        console.error(`Failed to update health status for ${clientForPrompt.name}:`, healthError);
      }
      
      throw error;
    }
  });

  // List Prompts Handler with improved error isolation
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const allPrompts: any[] = [];
    promptToClientMap.clear();

    const healthyClients = getHealthyClients();
    
    if (healthyClients.length === 0) {
      console.warn('No healthy servers available for prompts/list');
      return { prompts: allPrompts, nextCursor: request.params?.cursor };
    }

    const promptPromises = healthyClients.map(async (connectedClient) => {
      try {
        const result = await executeWithRetry(
          request,
          connectedClient,
          async (client) => {
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timeout')), 10000);
            });
            
            const requestPromise = client.client.request(
              {
                method: 'prompts/list' as const,
                params: {
                  cursor: request.params?.cursor,
                  _meta: request.params?._meta || {
                    progressToken: undefined
                  }
                }
              },
              ListPromptsResultSchema
            );
            
            return Promise.race([requestPromise, timeoutPromise]);
          }
        );

        if (result.prompts) {
          const promptsWithSource = result.prompts.map((prompt: any) => {
            promptToClientMap.set(prompt.name, connectedClient);
            return {
              ...prompt,
              description: `[${connectedClient.name}] ${prompt.description || ''}`
            };
          });
          return promptsWithSource;
        }
        return [];
      } catch (error) {
        console.error(`Error fetching prompts from ${connectedClient.name}:`, error);
        
        // 标记客户端为不连接状态
        connectedClient.isConnected = false;
        connectedClient.lastError = error instanceof Error ? error.message : 'Unknown error';
        
        // 更新健康状态
        try {
          healthMonitor.triggerHealthCheck(connectedClient);
        } catch (healthError) {
          console.error(`Failed to update health status for ${connectedClient.name}:`, healthError);
        }
        
        return []; // 返回空数组，不影响其他服务器
      }
    });

    const results = await Promise.allSettled(promptPromises);
    
    // 收集所有成功的结果
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allPrompts.push(...result.value);
      } else {
        console.error(`Failed to fetch prompts from ${healthyClients[index].name}:`, result.reason);
      }
    });

    return {
      prompts: allPrompts,
      nextCursor: request.params?.cursor
    };
  });

  // List Resources Handler with improved error isolation
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const allResources: any[] = [];
    resourceToClientMap.clear();

    const healthyClients = getHealthyClients();
    
    if (healthyClients.length === 0) {
      console.warn('No healthy servers available for resources/list');
      return { resources: allResources, nextCursor: undefined };
    }

    const resourcePromises = healthyClients.map(async (connectedClient) => {
      try {
        const result = await executeWithRetry(
          request,
          connectedClient,
          async (client) => {
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timeout')), 10000);
            });
            
            const requestPromise = client.client.request(
              {
                method: 'resources/list',
                params: {
                  cursor: request.params?.cursor,
                  _meta: request.params?._meta
                }
              },
              ListResourcesResultSchema
            );
            
            return Promise.race([requestPromise, timeoutPromise]);
          }
        );

        if (result.resources) {
          const resourcesWithSource = result.resources.map((resource: any) => {
            resourceToClientMap.set(resource.uri, connectedClient);
            return {
              ...resource,
              name: `[${connectedClient.name}] ${resource.name || ''}`
            };
          });
          return resourcesWithSource;
        }
        return [];
      } catch (error) {
        console.error(`Error fetching resources from ${connectedClient.name}:`, error);
        
        // 标记客户端为不连接状态
        connectedClient.isConnected = false;
        connectedClient.lastError = error instanceof Error ? error.message : 'Unknown error';
        
        // 更新健康状态
        try {
          healthMonitor.triggerHealthCheck(connectedClient);
        } catch (healthError) {
          console.error(`Failed to update health status for ${connectedClient.name}:`, healthError);
        }
        
        return []; // 返回空数组，不影响其他服务器
      }
    });

    const results = await Promise.allSettled(resourcePromises);
    
    // 收集所有成功的结果
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allResources.push(...result.value);
      } else {
        console.error(`Failed to fetch resources from ${healthyClients[index].name}:`, result.reason);
      }
    });

    return {
      resources: allResources,
      nextCursor: undefined
    };
  });

  // Read Resource Handler with improved error handling
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    let clientForResource = resourceToClientMap.get(uri);

    if (!clientForResource) {
      // 如果资源不在映射中，尝试重新获取资源列表来重建映射
      console.log(`Resource '${uri}' not found in mapping, attempting to rebuild resource mapping...`);
      
      try {
        resourceToClientMap.clear();
        
        const healthyClients = getHealthyClients();
        const resourcePromises = healthyClients.map(async (connectedClient) => {
          try {
            const result = await executeWithRetry(
              request,
              connectedClient,
              async (client) => {
                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('Request timeout')), 10000);
                });
                
                const requestPromise = client.client.request(
                  {
                    method: 'resources/list',
                    params: {
                      cursor: request.params?.cursor,
                      _meta: request.params?._meta
                    }
                  },
                  ListResourcesResultSchema
                );
                
                return Promise.race([requestPromise, timeoutPromise]);
              }
            );

            if (result.resources) {
              result.resources.forEach((resource: any) => {
                resourceToClientMap.set(resource.uri, connectedClient);
              });
              return result.resources;
            }
            return [];
          } catch (error) {
            console.warn(`Failed to get resources from ${connectedClient.name}:`, error);
            return [];
          }
        });

        await Promise.allSettled(resourcePromises);
        
        // 重新尝试获取资源映射
        clientForResource = resourceToClientMap.get(uri);
        
        if (clientForResource) {
          console.log(`✅ Successfully rebuilt resource mapping, found '${uri}' in ${clientForResource.name}`);
        } else {
          console.warn(`❌ Resource '${uri}' not found in any server after rebuilding mapping`);
        }
      } catch (error) {
        console.error(`Failed to rebuild resource mapping:`, error);
      }
    }

    if (!clientForResource) {
      throw new Error(`Resource '${uri}' is not available on any connected server. Please check if the resource exists and the server is running.`);
    }

    try {
      return await executeWithRetry(
        request,
        clientForResource,
        async (client) => {
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 15000);
          });
          
          const requestPromise = client.client.request(
            {
              method: 'resources/read',
              params: {
                uri,
                _meta: request.params._meta
              }
            },
            ReadResourceResultSchema
          );
          
          return Promise.race([requestPromise, timeoutPromise]);
        }
      );
    } catch (error) {
      console.error(`Error reading resource from ${clientForResource.name}:`, error);
      
      // 标记客户端为不连接状态
      clientForResource.isConnected = false;
      clientForResource.lastError = error instanceof Error ? error.message : 'Unknown error';
      
      // 更新健康状态
      try {
        healthMonitor.triggerHealthCheck(clientForResource);
      } catch (healthError) {
        console.error(`Failed to update health status for ${clientForResource.name}:`, healthError);
      }
      
      throw error;
    }
  });

  // List Resource Templates Handler with improved error isolation
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const allTemplates: ResourceTemplate[] = [];

    const healthyClients = getHealthyClients();
    
    if (healthyClients.length === 0) {
      console.warn('No healthy servers available for resource templates/list');
      return { resourceTemplates: allTemplates, nextCursor: request.params?.cursor };
    }

    const templatePromises = healthyClients.map(async (connectedClient) => {
      try {
        const result = await executeWithRetry(
          request,
          connectedClient,
          async (client) => {
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timeout')), 10000);
            });
            
            const requestPromise = client.client.request(
              {
                method: 'resources/templates/list' as const,
                params: {
                  cursor: request.params?.cursor,
                  _meta: request.params?._meta || {
                    progressToken: undefined
                  }
                }
              },
              ListResourceTemplatesResultSchema
            );
            
            return Promise.race([requestPromise, timeoutPromise]);
          }
        );

        if (result.resourceTemplates) {
          const templatesWithSource = result.resourceTemplates.map((template: any) => ({
            ...template,
            name: `[${connectedClient.name}] ${template.name || ''}`,
            description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
          }));
          return templatesWithSource;
        }
        return [];
      } catch (error) {
        console.error(`Error fetching resource templates from ${connectedClient.name}:`, error);
        
        // 标记客户端为不连接状态
        connectedClient.isConnected = false;
        connectedClient.lastError = error instanceof Error ? error.message : 'Unknown error';
        
        // 更新健康状态
        try {
          healthMonitor.triggerHealthCheck(connectedClient);
        } catch (healthError) {
          console.error(`Failed to update health status for ${connectedClient.name}:`, healthError);
        }
        
        return []; // 返回空数组，不影响其他服务器
      }
    });

    const results = await Promise.allSettled(templatePromises);
    
    // 收集所有成功的结果
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allTemplates.push(...result.value);
      } else {
        console.error(`Failed to fetch resource templates from ${healthyClients[index].name}:`, result.reason);
      }
    });

    return {
      resourceTemplates: allTemplates,
      nextCursor: request.params?.cursor
    };
  });

  // Add monitoring endpoints - 移除这个自定义处理器，因为它格式不正确
  // 监控功能将通过独立的Express服务器提供

  const cleanup = async () => {
    healthMonitor.stopMonitoring();
    await Promise.all(connectedClients.map(({ cleanup }) => cleanup()));
  };

  return { 
    server, 
    cleanup,
    components: {
      metricsManager,
      healthMonitor,
      smartSelector,
      connectedClients
    }
  };
};
