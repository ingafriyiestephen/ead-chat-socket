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

  const url = `https://me.eadpayroll.com/api/chat/user/${userId}/status`;

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
  
  // Get user type from stored user or fetch it
  const user = onlineUsers.get(userId) || {};
  
  // Emit online status to ALL clients
  io.emit("user-online", { 
    userId, 
    userType: user.userType,
    status: 'online',
    timestamp: new Date().toISOString()
  });
  
  // For HR users, also emit HR-specific status to ALL clients
  if (user.userType === 'hr') {
    io.emit('hr-status-update', { 
      hrId: parseInt(userId), 
      status: 'online',
      userType: 'hr',
      timestamp: new Date().toISOString()
    });
  }

  idleTimers[userId] = setTimeout(() => {
    updateUserStatus(userId, "idle");
    
    // Emit idle status to ALL clients
    io.emit("user-idle", { 
      userId,
      userType: user.userType,
      status: 'idle',
      timestamp: new Date().toISOString()
    });
    
    // For HR users, also emit HR-specific status to ALL clients
    if (user.userType === 'hr') {
      io.emit('hr-status-update', { 
        hrId: parseInt(userId), 
        status: 'idle',
        userType: 'hr',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`User ${userId} is now IDLE`);
  }, IDLE_TIMEOUT);
}

// ---------------------- SOCKET EVENTS ----------------------
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  const userType = socket.handshake.query.userType || "employee";
  console.log("User connected:", socket.id, "with userId:", userId, "and type:", userType);

  if (userId) {
    // Store user type
    const user = onlineUsers.get(userId) || {};
    user.userType = userType;
    onlineUsers.set(userId, user);
    
    // Join personal room for targeted messages
    socket.join(`user:${userId}`);
    
    // Join HR room if user is HR
    if (userType === 'hr') {
      socket.join('hrs');
      
      // Broadcast to ALL connected clients that this HR is online
      io.emit('hr-status-update', { 
        hrId: parseInt(userId), 
        status: 'online',
        userType: 'hr',
        timestamp: new Date().toISOString()
      });
      
      // Also broadcast to HR room
      io.to('hrs').emit('hr-online', { 
        hrId: parseInt(userId), 
        online: true,
        timestamp: new Date().toISOString()
      });
      
      console.log(`HR ${userId} connected - broadcasting online status to all`);
    }
    
    updateUserStatus(userId, "online");
    
    // Send user online event to ALL clients
    io.emit("user-online", { 
      userId, 
      userType,
      status: 'online',
      timestamp: new Date().toISOString()
    });
    
    resetIdle(userId);
  }

  // Join custom rooms
  socket.on("join", (room) => {
    socket.join(room);
    console.log(`User ${userId} joined room: ${room}`);
  });

  // Join conversation room
  socket.on("join-conversation", (conversationId) => {
    socket.join(`chat-${conversationId}`);
    console.log(`User ${userId} joined room chat-${conversationId}`);
    resetIdle(userId);
  });

  // HR status change (busy/away etc.)
  socket.on("hr-status-change", (data) => {
    // Update status
    updateUserStatus(userId, data.status);
    
    // Broadcast to ALL clients
    io.emit('hr-status-update', {
      hrId: parseInt(userId),
      status: data.status,
      online: data.online,
      userType: 'hr',
      lastSeen: data.lastSeen || new Date().toISOString(),
      timestamp: new Date().toISOString()
    });
    
    // Also broadcast to HR room
    io.to('hrs').emit("hr-status-changed", {
      hrId: parseInt(userId),
      online: data.online,
      status: data.status,
      lastSeen: new Date()
    });
  });

  // Chat message
  socket.on("chat-message", async (data) => {
    try {
      // Use the real ID if provided, otherwise fallback to Date.now()
      const msg = {
        id: data.id || Date.now(),  // Use real ID from database if available
        conversation_id: Number(data.conversationId),
        sender_id: String(data.senderId || userId),
        sender_type: data.senderType || userType,
        message: typeof data.message === "object" ? data.message.message : data.message,
        message_type: data.messageType || "text",
        created_at: new Date().toISOString(),
        
        // Include attachment data if present
        attachment_url: data.attachment_url || null,
        attachment_file: data.attachment_file || null,
        attachment_name: data.attachment_name || null,
        attachment_size: data.attachment_size || null,
        attachment_type: data.attachment_type || null,
        audio_duration: data.audio_duration || null,
      };
  
      io.to(`chat-${data.conversationId}`).emit("new-message", msg);
      console.log("Broadcasting message with attachment:", msg);
    } catch (error) {
      console.error("Error broadcasting message:", error);
      socket.emit("message-error", "Failed to broadcast message");
    }
  });

  // New conversation created (waiting queue)
  socket.on("new-conversation", (data) => {
    io.to('hrs').emit("new-waiting-conversation", data);
    console.log("New waiting conversation:", data);
  });

  // Conversation assigned/taken
  socket.on("conversation-assigned", (data) => {
    io.to('hrs').emit("conversation-assigned", data);
    console.log("Conversation assigned:", data);
  });

  // NEW: Conversation referred
  socket.on("conversation-referred", (data) => {
    console.log("Conversation referred:", data);
    
    // Broadcast to ALL HRs for list updates
    io.to('hrs').emit("conversation-referred", {
      to_hr_id: data.to_hr_id,
      from_hr_id: data.from_hr_id,
      from_hr_name: data.from_hr_name,
      conversation_id: data.conversation_id,
      conversation: data.conversation
    });
    
    // Also send to the specific HR's room for targeted notification
    if (data.to_hr_id) {
      io.to(`user:${data.to_hr_id}`).emit("referral-notification", {
        from_hr_id: data.from_hr_id,
        from_hr_name: data.from_hr_name,
        conversation_id: data.conversation_id,
        conversation: data.conversation
      });
      console.log(`Sent targeted notification to user:${data.to_hr_id}`);
    }
    
    // Also broadcast conversation update
    io.to('hrs').emit("conversation-updated", data.conversation);
  });

  // Referral accepted
  socket.on("referral-accepted", (data) => {
    console.log("Referral accepted:", data);
    
    // Prepare enhanced data with clear assignment info
    const enhancedData = {
      conversation_id: data.conversation_id,
      accepted_by: data.accepted_by,
      accepted_by_name: data.accepted_by_name,
      conversation: data.conversation || {
        id: data.conversation_id,
        status: 'active',
        hr_id: data.accepted_by,
        referred_to_hr_id: null,
        referred_by_hr_id: null
      },
      timestamp: new Date().toISOString()
    };
    
    // Broadcast to ALL HRs
    io.to('hrs').emit("referral-accepted", enhancedData);
    
    // IMPORTANT: Also broadcast to the conversation room so employee gets updated
    io.to(`chat-${data.conversation_id}`).emit("conversation-updated", {
      conversation_id: data.conversation_id,
      hr_id: data.accepted_by,
      hr_name: data.accepted_by_name,
      status: 'active'
    });
    
    // Also send to the original referrer specifically (if different from accepter)
    if (data.original_referrer_id && data.original_referrer_id !== data.accepted_by) {
      io.to(`user:${data.original_referrer_id}`).emit("referral-accepted-notification", {
        conversation_id: data.conversation_id,
        accepted_by_name: data.accepted_by_name,
        message: `Your referral was accepted by ${data.accepted_by_name}`
      });
    }
  });

  // Referral declined
  socket.on("referral-declined", (data) => {
    console.log("Referral declined:", data);
    
    // Prepare enhanced data with clear assignment info
    const enhancedData = {
      conversation_id: data.conversation_id,
      declined_by: data.declined_by,
      declined_by_name: data.declined_by_name,
      conversation: data.conversation || {
        id: data.conversation_id,
        status: 'active',
        hr_id: data.original_referrer_id, // Should go back to original referrer
        referred_to_hr_id: null,
        referred_by_hr_id: null
      },
      original_referrer_id: data.original_referrer_id,
      timestamp: new Date().toISOString()
    };
    
    // Broadcast to ALL HRs
    io.to('hrs').emit("referral-declined", enhancedData);
    
    // Send to the original referrer specifically
    if (data.original_referrer_id) {
      io.to(`user:${data.original_referrer_id}`).emit("referral-returned", {
        conversation_id: data.conversation_id,
        declined_by_name: data.declined_by_name,
        message: `Your referral was declined by ${data.declined_by_name} and has been returned to you`
      });
    }
  });

  // Refresh conversations
  socket.on('refresh-conversations', (data) => {
    console.log('Refresh conversations requested:', data);
    
    if (data.target_user_id) {
      // Send refresh signal only to specific user
      io.to(`user:${data.target_user_id}`).emit('refresh-conversations', {
        conversation_id: data.conversation_id
      });
    } else {
      // Broadcast to all HRs
      io.to('hrs').emit('refresh-conversations', {
        conversation_id: data.conversation_id
      });
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
      conversationId: data.conversationId,
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
    
    // Get user type from stored user
    const user = onlineUsers.get(userId) || {};
    
    // Emit user offline to ALL clients
    io.emit("user-offline", { 
      userId, 
      userType: user.userType,
      lastSeen: new Date(),
      status: 'offline'
    });
    
    // If HR, emit HR offline to ALL clients
    if (user.userType === 'hr') {
      io.emit('hr-status-update', { 
        hrId: parseInt(userId), 
        status: 'offline',
        userType: 'hr',
        lastSeen: new Date().toISOString()
      });
      
      // Also send to HR room
      io.to('hrs').emit("hr-offline", { 
        hrId: parseInt(userId), 
        online: false,
        lastSeen: new Date().toISOString()
      });
      
      console.log(`HR ${userId} disconnected - broadcasting offline status to all`);
    }
    
    console.log("User disconnected:", userId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});