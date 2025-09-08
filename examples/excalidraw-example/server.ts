import { SimpleServer } from "loro-websocket/server";

const server = new SimpleServer({
  port: 8080,
  host: "localhost",
  saveInterval: 30000, // Save every 30 seconds
  onLoadDocument: async (roomId, crdtType) => {
    console.log(`Loading document for room: ${roomId}, type: ${crdtType}`);
    // In a real app, you would load from database
    return null;
  },
  onSaveDocument: async (roomId, crdtType, data) => {
    console.log(`Saving document for room: ${roomId}, type: ${crdtType}, size: ${data.byteLength} bytes`);
    // In a real app, you would save to database
  },
});

void server
  .start()
  .then(() => {
    console.log("WebSocket server running on ws://localhost:8080");
  })
  .catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down server...");
  await server.stop();
  process.exit(0);
});
