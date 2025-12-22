#!/usr/bin/env node
// Test GPU telemetry streaming via WebSocket

const ws = require("ws");
const client = new ws("ws://127.0.0.1:8787/ws");

let messageCount = 0;

client.on("open", () => {
  console.log("[GPU Telemetry Test]");
  console.log("WebSocket connected to backend");
});

client.on("message", (data) => {
  messageCount++;
  const msg = JSON.parse(data);
  
  if (msg.type === "system_stats") {
    const { gpu, cpu, ram, disk } = msg.payload;
    console.log(`\n[Message ${messageCount}] System Stats:`);
    console.log(`  GPU: ${gpu.name}`);
    console.log(`    Available: ${gpu.available}`);
    console.log(`    Utilization: ${gpu.utilPct}%`);
    console.log(`    VRAM: ${gpu.vramUsedMB}/${gpu.vramTotalMB} MB`);
    console.log(`    Temperature: ${gpu.temperatureC}°C`);
    console.log(`    Power Draw: ${gpu.powerW}W`);
    console.log(`  CPU: ${cpu.utilPct}% (${cpu.threads} threads)`);
    console.log(`  RAM: ${ram.usedMB}/${ram.totalMB} MB`);
    console.log(`  Disk: Read ${disk.readMBps} MB/s, Write ${disk.writeMBps} MB/s`);
  }
  
  if (messageCount >= 5) {
    console.log("\n[Test Complete] Received 5 GPU telemetry updates!");
    client.close();
    process.exit(0);
  }
});

client.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("Timeout: Did not receive 5 messages within 10 seconds");
  client.close();
  process.exit(1);
}, 10000);
