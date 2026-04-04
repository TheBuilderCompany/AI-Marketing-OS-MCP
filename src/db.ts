import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/marketing_mcp";

let isConnected = false;

/**
 * Connects to MongoDB using Mongoose.
 * Uses a singleton pattern to reuse the connection across tool calls.
 */
export async function connectToDatabase(): Promise<void> {
  if (isConnected) {
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      connectTimeoutMS: 30000,
    });

    isConnected = true;
    console.log(`✅ MongoDB connected: ${MONGODB_URI}`);

    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB connection error:", err);
      isConnected = false;
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️  MongoDB disconnected. Will reconnect on next request.");
      isConnected = false;
    });
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
    throw error;
  }
}

/**
 * Gracefully closes the MongoDB connection.
 * Called during server shutdown via PM2 signals.
 */
export async function disconnectFromDatabase(): Promise<void> {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    console.log("🔌 MongoDB disconnected gracefully.");
  }
}
