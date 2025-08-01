#!/usr/bin/env node

/**
 * MCP Proxy Server with Smart Selection and Monitoring
 * 
 * This server implements intelligent MCP server selection strategies,
 * real-time performance monitoring, and automatic failover capabilities.
 * It provides a unified interface for multiple MCP servers while ensuring
 * optimal performance and reliability.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp-proxy.js";
import { MonitoringDashboard } from "./monitoring-dashboard.js";
import { MetricsManager } from "./metrics-manager.js";
import { SmartSelector } from "./selection-strategies.js";
import { HealthMonitor } from "./health-monitor.js";
import { createClients } from "./client.js";
import { loadConfig } from "./config.js";

async function main() {
  const transport = new StdioServerTransport();
  const { server, cleanup, components } = await createServer();

  await server.connect(transport);

  // Start monitoring dashboard if enabled
  if (components?.metricsManager && components?.healthMonitor && 
      components?.smartSelector && components?.connectedClients) {
    
    const dashboard = new MonitoringDashboard(
      components.metricsManager,
      components.healthMonitor,
      components.smartSelector,
      components.connectedClients
    );
    
    // Start dashboard on port 3000
    dashboard.start(3000);
    
    console.log('🚀 MCP Proxy Server started with monitoring dashboard');
    console.log('📊 Dashboard available at: http://localhost:3000/dashboard');
    console.log('🔧 API endpoints available at: http://localhost:3000/api/');
  } else {
    console.log('🚀 MCP Proxy Server started');
  }

  // Cleanup on exit
  process.on("SIGINT", async () => {
    console.log('\n🛑 Shutting down MCP Proxy Server...');
    await cleanup();
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});
