import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { createServer } from "./mcp-proxy.js";
import { MonitoringDashboard } from "./monitoring-dashboard.js";

const app = express();

const { server, cleanup, components } = await createServer();

// 启动监控仪表板（如果组件可用）
if (components?.metricsManager && components?.healthMonitor && 
    components?.smartSelector && components?.connectedClients) {
  
  const dashboard = new MonitoringDashboard(
    components.metricsManager,
    components.healthMonitor,
    components.smartSelector,
    components.connectedClients
  );
  
  // 启动仪表板在端口3000
  dashboard.start(3000);
  
  console.log('🚀 MCP Proxy Server (SSE) started with monitoring dashboard');
  console.log('📊 Dashboard available at: http://localhost:3000/dashboard');
  console.log('🔧 API endpoints available at: http://localhost:3000/api/');
} else {
  console.log('🚀 MCP Proxy Server (SSE) started');
}

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  console.log("Received connection");
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);

  server.onerror = (err) => {
    console.error(`Server onerror: ${err.stack}`)
  }

  server.onclose = async () => {
    console.log('Server onclose')
    if (process.env.KEEP_SERVER_OPEN !== "1") {
      await cleanup();
      await server.close();
      process.exit(0);
    }
  };
});

app.post("/message", async (req, res) => {
  console.log("Received message");
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
  console.log(`SSE Server is running on port ${PORT}`);
});
