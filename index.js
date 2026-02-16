const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // ⚠️ change to your frontend domain in production
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3001;

// ---------------------- USER STORE ----------------------
const onlineUsers = new Map();
const idleTimers = {};
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ---------------------- HELPERS ----------------------
async function updateUserStatus(userId, status) {
  if (!userId) return;

  const url = `https://me.eadpayroll.com/api/user/${userId}/status`;

  try {
    await axios.post(url, { status });
  } catch (err) {
    console.error("Failed to update user status:", err.response?.data || err.message);
  }

  const user = onlineUsers.get(userId) || {};
  user.status = status;
  if (status === "offline") user.lastSeen = new Date();
  onlineUsers.set(userId, user);

  console.log(`User ${userId} set to ${status}`);
}

function setUserLastSeen(userId, date) {
  if (!userId) return;
  const user = onlineUsers.get(userId) || {};
  user.lastSeen = date;
  user.status = "offline";
  onlineUsers.set(userId, user);
}

function markMessageAsRead(messageId, readerId) {
  console.log(`Message ${messageId} is marked as read by user ${readerId}`);
}

function resetIdle(userId) {
  if (!userId) return;

  clearTimeout(idleTimers[userId]);

  updateUserStatus(userId, "online");
  io.emit("user-active", { userId });

  idleTimers[userId] = setTimeout(() => {
    updateUserStatus(userId, "idle");
    io.emit("user-idle", { userId });
    console.log(`User ${userId} is now IDLE`);
  }, IDLE_TIMEOUT);
}

// ---------------------- SOCKET EVENTS ----------------------
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  const userType = socket.handshake.query.userType || "employee"; // add userType in client handshake
  console.log("User connected:", socket.id, "with userId:", userId, "and type:", userType);

  if (userId) {
    updateUserStatus(userId, "online");
    io.emit("user-online", { userId, userType });
    resetIdle(userId);
  }

  // Join room
  socket.on("join-conversation", (conversationId) => {
    socket.join(`chat-${conversationId}`);
    console.log(`User ${userId} joined room chat-${conversationId}`);
    resetIdle(userId);
  });

  socket.on("chat-message", async (data) => {
    try {
      const msg = {
        id: Date.now(),
        conversation_id: Number(data.conversationId),
        sender_id: String(data.senderId || userId),
        sender_type: data.senderType || userType,
        message: typeof data.message === "object" ? data.message.message : data.message,
        message_type: data.messageType || "text",
        created_at: new Date().toISOString(),
        
        // ADD THESE LINES - Include attachment data if present
        attachment_url: data.attachment_url || null,
        attachment_file: data.attachment_file || null,
        attachment_name: data.attachment_name || null,
        attachment_size: data.attachment_size || null,
        attachment_type: data.attachment_type || null,
      };
  
      io.to(`chat-${data.conversationId}`).emit("new-message", msg);
      console.log("Broadcasting message with attachment:", msg);
    } catch (error) {
      console.error("Error broadcasting message:", error);
      socket.emit("message-error", "Failed to broadcast message");
    }
  });

  // Typing indicator
  socket.on("start-typing", ({ conversationId }) => {
    if (!conversationId || !userId) return;

    resetIdle(userId);

    socket.to(`chat-${conversationId}`).emit("user-typing", {
      conversationId,
      userId,
      userType,
    });
    console.log(`User ${userId} (${userType}) is typing in conversation ${conversationId}`);
  });

  socket.on("stop-typing", ({ conversationId }) => {
    if (!conversationId || !userId) return;

    socket.to(`chat-${conversationId}`).emit("user-stop-typing", {
      conversationId,
      userId,
      userType,
    });
    console.log(`User ${userId} stopped typing in conversation ${conversationId}`);
  });

  // Mark as read
  socket.on("mark-as-read", ({ messageId, conversationId, readerId }) => {
    if (!conversationId || !readerId) return;

    markMessageAsRead(messageId, readerId);
    io.to(`chat-${conversationId}`).emit("message-read", { messageId, userId: readerId });
    resetIdle(readerId);
  });

  // Deleting messages
  socket.on("message-deleted", (data) => {
    io.to(`chat-${data.conversationId}`).emit("message-deleted", {
      messageId: data.messageId,
      deletedAt: new Date(),
    });
    console.log(`Message ${data.messageId} deleted in conversation ${data.conversationId}`);
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (!userId) return;
    clearTimeout(idleTimers[userId]);
    updateUserStatus(userId, "offline");
    setUserLastSeen(userId, new Date());
    io.emit("user-offline", { userId, lastSeen: new Date() });
    console.log("User disconnected:", userId);
  });
});


server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});