import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ServerConfig } from './config.js';

const sleep = (time: number) => new Promise<void>(resolve => setTimeout(() => resolve(), time))

export interface ConnectedClient {
  client: Client;
  cleanup: () => Promise<void>;
  name: string;
  isConnected: boolean; // 添加连接状态
  lastError?: string; // 添加最后错误信息
  lastErrorLogged: boolean; // 添加最后错误日志标记
}

const createClient = (server: ServerConfig): { client: Client | undefined, transport: Transport | undefined } => {

  let transport: Transport | null = null
  try {
    if (server.transport.type === 'sse') {
      transport = new SSEClientTransport(new URL(server.transport.url));
    } else {
      transport = new StdioClientTransport({
        command: server.transport.command,
        args: server.transport.args,
        env: server.transport.env ? server.transport.env.reduce((o, v) => ({
          [v]: process.env[v] || ''
        }), {}) : undefined
      });
    }
  } catch (error) {
    console.error(`Failed to create transport ${server.transport.type || 'stdio'} to ${server.name}:`, error);
  }

  if (!transport) {
    console.warn(`Transport ${server.name} not available.`)
    return { transport: undefined, client: undefined }
  }

  const client = new Client({
    name: 'mcp-proxy-client',
    version: '1.0.0',
  }, {
    capabilities: {
      prompts: {},
      resources: { subscribe: true },
      tools: {}
    }
  });

  return { client, transport }
}

export const createClients = async (servers: ServerConfig[]): Promise<ConnectedClient[]> => {
  const clients: ConnectedClient[] = [];

  for (const server of servers) {
    console.log(`Connecting to server: ${server.name}`);

    const waitFor = 2500
    const retries = 3
    let count = 0
    let retry = true

    while (retry) {

      const { client, transport } = createClient(server)
      if (!client || !transport) {
        console.error(`Failed to create client for ${server.name}`);
        break
      }

      try {
        await client.connect(transport);
        console.log(`Connected to server: ${server.name}`);

        // 添加连接状态监听
        const connectedClient: ConnectedClient = {
          client,
          name: server.name,
          isConnected: true,
          lastErrorLogged: false, // 初始化标记
          cleanup: async () => {
            connectedClient.isConnected = false;
            try {
              await transport.close();
            } catch (error) {
              console.warn(`Error closing transport for ${server.name}:`, error);
            }
          }
        };

        // 监听连接错误
        transport.onerror = (error) => {
          console.warn(`Transport error for ${server.name}:`, error);
          connectedClient.isConnected = false;
          connectedClient.lastError = error.message;
          // 只在状态变化时输出日志，避免重复
          if (!connectedClient.lastErrorLogged) {
            console.log(`🔴 ${server.name} 连接状态更新: 已断开 (错误: ${error.message})`);
            connectedClient.lastErrorLogged = true;
          }
        };

        // 监听连接关闭
        transport.onclose = () => {
          console.warn(`Transport closed for ${server.name}`);
          connectedClient.isConnected = false;
          connectedClient.lastError = 'Connection closed';
          // 只在状态变化时输出日志，避免重复
          if (!connectedClient.lastErrorLogged) {
            console.log(`🔴 ${server.name} 连接状态更新: 已断开 (连接关闭)`);
            connectedClient.lastErrorLogged = true;
          }
        };

        // 对于SSE连接，添加额外的状态检查
        if (server.transport.type === 'sse') {
          console.log(`🔧 为SSE连接 ${server.name} 添加额外状态检查`);
          
          // 定期检查SSE连接状态
          const checkSSEConnection = () => {
            if (connectedClient.isConnected) {
              // 对于SSE连接，检查transport的readyState
              const sseTransport = transport as any; // 类型断言
              if (sseTransport.readyState !== undefined) {
                // EventSource readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
                if (sseTransport.readyState === 2) { // CLOSED
                  console.warn(`SSE连接 ${server.name} 检测到已关闭 (readyState: ${sseTransport.readyState})`);
                  connectedClient.isConnected = false;
                  connectedClient.lastError = 'SSE connection closed';
                  console.log(`🔴 ${server.name} 连接状态更新: 已断开 (SSE检测)`);
                }
              }
            }
          };
          
          // 每30秒检查一次SSE连接状态 (从5秒改为30秒)
          const sseCheckInterval = setInterval(() => {
            if (!connectedClient.isConnected) {
              clearInterval(sseCheckInterval);
              return;
            }
            checkSSEConnection();
          }, 30000);
          
          // 在cleanup时清除定时器
          const originalCleanup = connectedClient.cleanup;
          connectedClient.cleanup = async () => {
            clearInterval(sseCheckInterval);
            await originalCleanup();
          };
        }

        clients.push(connectedClient);
        break

      } catch (error) {
        console.error(`Failed to connect to ${server.name}:`, error);
        count++
        retry = (count < retries)
        if (retry) {
          try {
            await client.close()
          } catch { }
          console.log(`Retry connection to ${server.name} in ${waitFor}ms (${count}/${retries})`);
          await sleep(waitFor)
        }
      }

    }

  }

  return clients;
};
