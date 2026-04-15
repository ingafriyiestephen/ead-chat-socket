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

// Store active live location sessions
const liveLocationSessions = new Map(); // conversationId -> { userId, userType, startTime, duration, interval }

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
  
  const user = onlineUsers.get(userId) || {};
  
  io.emit("user-online", { 
    userId, 
    userType: user.userType,
    status: 'online',
    timestamp: new Date().toISOString()
  });
  
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
    
    io.emit("user-idle", { 
      userId,
      userType: user.userType,
      status: 'idle',
      timestamp: new Date().toISOString()
    });
    
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

// ---------------------- LIVE LOCATION HANDLERS ----------------------
function startLiveLocationSession(conversationId, userId, userType, duration) {
  const sessionKey = `${conversationId}_${userId}`;
  
  if (liveLocationSessions.has(sessionKey)) {
    stopLiveLocationSession(conversationId, userId);
  }

  const session = {
    userId,
    userType,
    startTime: new Date().toISOString(),
    duration,
    interval: null
  };

  liveLocationSessions.set(sessionKey, session);
  console.log(`Live location session started for conversation ${conversationId} by ${userId}`);

  if (duration && duration > 0) {
    setTimeout(() => {
      stopLiveLocationSession(conversationId, userId);
    }, duration * 60 * 1000);
  }

  return session;
}

function stopLiveLocationSession(conversationId, userId) {
  const sessionKey = `${conversationId}_${userId}`;
  const session = liveLocationSessions.get(sessionKey);
  
  if (session) {
    liveLocationSessions.delete(sessionKey);
    console.log(`Live location session ended for conversation ${conversationId} by ${userId}`);
    
    // Broadcast to all participants that live location has ended
    io.to(`chat-${conversationId}`).emit('live-location-ended', {
      conversationId,
      userId,
      endedAt: new Date().toISOString()
    });
    
    return true;
  }
  
  console.log(`No active live location session found for conversation ${conversationId} by ${userId}`);
  return false;
}



// ---------------------- SOCKET EVENTS ----------------------
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  const userType = socket.handshake.query.userType || "employee";
  console.log("User connected:", socket.id, "with userId:", userId, "and type:", userType);
  // Add a sequence counter for each conversation
  const messageSequences = new Map();

  if (userId) {
    const user = onlineUsers.get(userId) || {};
    user.userType = userType;
    onlineUsers.set(userId, user);
    
    socket.join(`user:${userId}`);
    
    if (userType === 'hr') {
      socket.join('hrs');
      
      io.emit('hr-status-update', { 
        hrId: parseInt(userId), 
        status: 'online',
        userType: 'hr',
        timestamp: new Date().toISOString()
      });
      
      io.to('hrs').emit('hr-online', { 
        hrId: parseInt(userId), 
        online: true,
        timestamp: new Date().toISOString()
      });
      
      console.log(`HR ${userId} connected - broadcasting online status to all`);
    }
    
    updateUserStatus(userId, "online");
    
    io.emit("user-online", { 
      userId, 
      userType,
      status: 'online',
      timestamp: new Date().toISOString()
    });
    
    resetIdle(userId);
  }

  socket.on("join", (room) => {
    socket.join(room);
    console.log(`User ${userId} joined room: ${room}`);
  });

  socket.on("join-conversation", (conversationId) => {
    socket.join(`chat-${conversationId}`);
    console.log(`User ${userId} joined room chat-${conversationId}`);
    resetIdle(userId);
  });

  socket.on("hr-status-change", (data) => {
    updateUserStatus(userId, data.status);
    
    io.emit('hr-status-update', {
      hrId: parseInt(userId),
      status: data.status,
      online: data.online,
      userType: 'hr',
      lastSeen: data.lastSeen || new Date().toISOString(),
      timestamp: new Date().toISOString()
    });
    
    io.to('hrs').emit("hr-status-changed", {
      hrId: parseInt(userId),
      online: data.online,
      status: data.status,
      lastSeen: new Date()
    });
  });

  // ADD: group member add notification
  socket.on('group-member-added', (data) => {
    const { conversationId, newMember, addedBy, memberIds } = data;

    // Broadcast to everyone already in the conversation room
    io.to(`chat-${conversationId}`).emit('group-member-added', {
      conversationId,
      newMember,
      addedBy,
      timestamp: new Date().toISOString()
    });
  
    // ✅ Also notify the newly added member directly via their personal room
    // so their conversations list updates even before they join the chat room
    io.to(`user:${newMember.id}`).emit('group-member-added', {
      conversationId,
      newMember,
      addedBy,
      timestamp: new Date().toISOString()
    });
  
    console.log(`Member ${newMember.name} added to group ${conversationId}`);
  });

  // Group member removed (by admin)
  socket.on('group-member-removed', (data) => {
    const { conversationId, removedMember, removedBy } = data;

    io.to(`chat-${conversationId}`).emit('group-member-removed', {
      conversationId,
      removedMember,
      removedBy,
      timestamp: new Date().toISOString()
    });
  
    // ✅ Notify removed member directly so their list updates immediately
    io.to(`user:${removedMember.id}`).emit('group-member-removed', {
      conversationId,
      removedMember,
      removedBy,
      timestamp: new Date().toISOString()
    });
  });

  // Group member left (voluntarily)
  socket.on('group-member-left', (data) => {
    const { conversationId, leavingMember } = data;
    
    console.log(`🚪 Member ${leavingMember.name} left group ${conversationId}`);
    
    io.to(`chat-${conversationId}`).emit('group-member-left', {
      conversationId,
      leavingMember,
      timestamp: new Date().toISOString()
    });
  });

  // In your socket initialization
  socket.on('join-conversation', (conversationId) => {
    socket.join(`chat-${conversationId}`);
    console.log(`User ${userId} joined room chat-${conversationId}`);
  });

  // For direct chats, also join a unique room based on user IDs
  socket.on('join-direct-chat', (data) => {
    const roomName = `direct-${Math.min(data.user1, data.user2)}-${Math.max(data.user1, data.user2)}`;
    socket.join(roomName);
    console.log(`User joined direct room: ${roomName}`);
  });

  // In your chat-message handler:
  socket.on("chat-message", async (data) => {
    try {
      const convId = data.conversationId;
    
      // CRITICAL: Get current sequence for this conversation
      let lastSeq = messageSequences.get(convId) || 0;
      const newSeq = lastSeq + 1;
      
      // IMPORTANT: Update the Map BEFORE broadcasting
      messageSequences.set(convId, newSeq);
      
      console.log(`📨 [SEQUENCE] Conversation ${convId}: Current lastSeq=${lastSeq}, newSeq=${newSeq}`);
      
      const msg = {
        id: data.id || Date.now(),
        conversation_id: Number(convId),
        sender_id: String(data.senderId || userId),
        sender_type: data.senderType || userType,
        sender_name: data.senderName || null,
        sender: data.sender || null,
        message: typeof data.message === "object" ? data.message.message : data.message,
        message_type: data.messageType || data.message_type || "text",  // ← also check snake_case
        created_at: new Date().toISOString(),
        sequence: newSeq,
        
        // encryption fields (unchanged)
        is_encrypted: data.is_encrypted || false,
        encrypted_payload: data.encrypted_payload || null,
        sender_key_fingerprint: data.sender_key_fingerprint || null,

        // reply to fields
        reply_to_id: data.reply_to_id || null,   // ← add
        reply_to: data.reply_to || null,          // ← add
        
        // attachment fields (unchanged)
        attachment_url: data.attachment_url || null,
        attachment_file: data.attachment_file || null,
        attachment_name: data.attachment_name || null,
        attachment_size: data.attachment_size || null,
        attachment_type: data.attachment_type || null,
        audio_duration: data.audio_duration || null,
        video_duration: data.video_duration || null,
        video_thumbnail: data.video_thumbnail || null,
        
        // ← ADD THESE THREE (they were missing from the broadcast):
        poll_data: data.poll_data || null,
        poll_id: data.poll_id || null,
        location_data: data.location_data || null,
        contact_data: data.contact_data || null,
      };

      console.log(`📤 [SEQUENCE] Broadcasting message ${newSeq} to conversation ${convId}`);
      
      // AFTER — broadcast to chat room AND notify all HRs for dashboard list update
      io.to(`chat-${convId}`).emit("new-message", msg);

      // Let the HR dashboard know a new message arrived (for badge + preview update)
      io.to("hrs").emit("new-message", {
        ...msg,
        conversation_id: Number(convId),  // ensure it's always present
      });
      
    } catch (error) {
      console.error("Error broadcasting message:", error);
      socket.emit("message-error", "Failed to broadcast message");
    }
  });

  // Add this in the io.on("connection") block
  socket.on("message-reaction", (data) => {
    const { conversationId, messageId, emoji, action, reactions } = data;
    if (!conversationId || !messageId) return;
    
    // Broadcast to everyone in the conversation room EXCEPT the sender
    socket.to(`chat-${conversationId}`).emit("message-reaction", {
      conversationId,
      messageId,
      emoji,
      action,
      reactions,
      reactedBy: userId,
    });
    
    console.log(`Reaction ${emoji} (${action}) on message ${messageId} in conversation ${conversationId}`);
  });

  // Pin message handler — broadcast to all participants
  socket.on("message-pin", (data) => {
    const { conversationId, messageId, pinned, userId, userType, messageData } = data;

    if (!conversationId || !messageId) return;

    // Broadcast to everyone in the conversation room EXCEPT the sender
    socket.to(`chat-${conversationId}`).emit("message-pin-updated", {
      conversationId,
      messageId,
      pinned,
      userId: userId || socket.handshake.query.userId,
      userType: userType || socket.handshake.query.userType,
      messageData: messageData || null,
      timestamp: new Date().toISOString()
    });

    console.log(`Message ${messageId} ${pinned ? 'pinned' : 'unpinned'} by user ${userId} in conversation ${conversationId}`);
  });

  // Add star handler for real-time star updates
  socket.on("message-star", (data) => {
    const { conversationId, messageId, starred, userId, userType } = data;
    
    if (!conversationId || !messageId) return;
    
    // Broadcast to everyone in the conversation room EXCEPT the sender
    socket.to(`chat-${conversationId}`).emit("message-star-updated", {
      conversationId,
      messageId,
      starred,
      userId: userId || socket.handshake.query.userId,
      userType: userType || socket.handshake.query.userType,
      timestamp: new Date().toISOString()
    });
    
    console.log(`Message ${messageId} ${starred ? 'starred' : 'unstarred'} by user ${userId} in conversation ${conversationId}`);
  });


  socket.on('poll-vote-updated', (data) => {
    const { conversationId, pollId, options, totalVotes } = data;
    socket.to(`chat-${conversationId}`).emit('poll-vote-updated', {
      conversationId,
      pollId,
      options,
      totalVotes,
      votedBy: userId,
      timestamp: new Date().toISOString()
    });
    console.log(`Poll ${pollId} updated in conversation ${conversationId}`);
  });
  
  // Live location end
  socket.on('live-location-start', (data) => {
    const { conversationId, userId, userType, duration } = data;
    
    console.log(`🔴 Live location start for conversation ${conversationId} from ${userId}`);
    
    const sessionKey = `${conversationId}_${userId}`;
    
    // Store the session
    const session = {
      userId,
      userType,
      startTime: new Date().toISOString(),
      duration,
      active: true
    };
    
    liveLocationSessions.set(sessionKey, session);
    
    // Broadcast to all participants that live location has started
    io.to(`chat-${conversationId}`).emit('live-location-started', {
      conversationId,
      userId,
      userType,
      duration,
      startTime: session.startTime
    });
    
    console.log(`✅ Live location session created for conversation ${conversationId} for user ${userId}`);
  });

  // Live location update (separate from regular messages)
  socket.on("live-location-update", (data) => {
    const { conversationId, location, userId } = data;
    
    // Use the combined key format
    const sessionKey = `${conversationId}_${userId}`;
    
    if (!liveLocationSessions.has(sessionKey)) {
      console.log(`No active live location session for conversation ${conversationId} from user ${userId}`);
      return;
    }
    
    io.to(`chat-${conversationId}`).emit("live-location-update", {
      conversationId,
      userId,
      userType: data.userType,
      location: {
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy,
        timestamp: location.timestamp || new Date().toISOString()
      }
    });
    
    console.log(`📍 Live location update in conversation ${conversationId} from ${userId}`);
  });

  // Live location ended
  socket.on("live-location-end", (data) => {
    const { conversationId, userId } = data;
    
    const sessionKey = `${conversationId}_${userId}`;
    
    if (liveLocationSessions.has(sessionKey)) {
      liveLocationSessions.delete(sessionKey);
    }
    
    io.to(`chat-${conversationId}`).emit("live-location-ended", {
      conversationId,
      userId,
      endedAt: new Date().toISOString()
    });
    
    console.log(`🔴 Live location ended in conversation ${conversationId} for user ${userId}`);
  });

  // New conversation created
  socket.on("new-conversation", (data) => {
    io.to('hrs').emit("new-waiting-conversation", data);
    console.log("New waiting conversation:", data);
  });

  // Conversation assigned
  socket.on("conversation-assigned", (data) => {
    io.to('hrs').emit("conversation-assigned", data);
    console.log("Conversation assigned:", data);
  });


  // Conversation referred
  socket.on("conversation-referred", (data) => {
    console.log("Conversation referred:", data);
    
    io.to('hrs').emit("conversation-referred", {
      to_hr_id: data.to_hr_id,
      from_hr_id: data.from_hr_id,
      from_hr_name: data.from_hr_name,
      conversation_id: data.conversation_id,
      conversation: data.conversation
    });
    
    if (data.to_hr_id) {
      io.to(`user:${data.to_hr_id}`).emit("referral-notification", {
        from_hr_id: data.from_hr_id,
        from_hr_name: data.from_hr_name,
        conversation_id: data.conversation_id,
        conversation: data.conversation
      });
      console.log(`Sent targeted notification to user:${data.to_hr_id}`);
    }
    
    // ✅ Only emit conversation-updated if conversation data exists
    if (data.conversation && data.conversation.id) {
      io.to('hrs').emit("conversation-updated", data.conversation);
    } else {
      console.log('Skipping conversation-updated emit - no conversation data');
    }
  });

  // Referral accepted
  socket.on("referral-accepted", (data) => {
    console.log("Referral accepted:", data);
    
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
    
    io.to('hrs').emit("referral-accepted", enhancedData);
    
    io.to(`chat-${data.conversation_id}`).emit("conversation-updated", {
      conversation_id: data.conversation_id,
      hr_id: data.accepted_by,
      hr_name: data.accepted_by_name,
      status: 'active'
    });
    
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
    
    const enhancedData = {
      conversation_id: data.conversation_id,
      declined_by: data.declined_by,
      declined_by_name: data.declined_by_name,
      conversation: data.conversation || {
        id: data.conversation_id,
        status: 'active',
        hr_id: data.original_referrer_id,
        referred_to_hr_id: null,
        referred_by_hr_id: null
      },
      original_referrer_id: data.original_referrer_id,
      timestamp: new Date().toISOString()
    };
    
    io.to('hrs').emit("referral-declined", enhancedData);
    
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
      io.to(`user:${data.target_user_id}`).emit('refresh-conversations', {
        conversation_id: data.conversation_id
      });
    } else {
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

  // AFTER
  socket.on("mark-as-read", ({ messageId, conversationId, readerId }) => {
    if (!conversationId || !readerId) return;
    markMessageAsRead(messageId, readerId);
    // Include conversationId in the payload so all listeners can identify which convo was read
    io.to(`chat-${conversationId}`).emit("message-read", {
      messageId,
      conversationId,          // ← added
      readerId,                // ← renamed from userId for clarity
      userId: readerId,        // ← keep for backward compat with chat view
    });
    resetIdle(readerId);
  });

  // NEW — dashboard emits 'mark-read', normalize it to the same logic
  socket.on("mark-read", ({ conversation_id, hr_id }) => {
    if (!conversation_id || !hr_id) return;
    const conversationId = conversation_id;
    const readerId = hr_id;
    markMessageAsRead(null, readerId);
    io.to(`chat-${conversationId}`).emit("message-read", {
      conversationId,
      readerId,
      userId: readerId,
    });
    // Also notify HRs room so other HR tabs update their badge
    io.to("hrs").emit("message-read", {
      conversationId,
      readerId,
    });
    resetIdle(String(readerId));
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
    
    const user = onlineUsers.get(userId) || {};
    
    // End any active live location sessions for this user
    for (const [key, session] of liveLocationSessions.entries()) {
      if (session.userId === userId) {
        liveLocationSessions.delete(key);
        // Extract conversationId from the key
        const conversationId = key.split('_')[0];
        io.to(`chat-${conversationId}`).emit('live-location-ended', {
          conversationId: parseInt(conversationId),
          userId,
          endedAt: new Date().toISOString()
        });
      }
    }
    
    io.emit("user-offline", { 
      userId, 
      userType: user.userType,
      lastSeen: new Date(),
      status: 'offline'
    });
    
    if (user.userType === 'hr') {
      io.emit('hr-status-update', { 
        hrId: parseInt(userId), 
        status: 'offline',
        userType: 'hr',
        lastSeen: new Date().toISOString()
      });
      
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