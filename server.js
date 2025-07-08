const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const connectDB = require('./config/database');

// Import models for session cleanup
const EmployeeSession = require('./models/EmployeeSession');
const ActivityLog = require('./models/ActivityLog');

// Load environment variables
dotenv.config();

// Connect to database
connectDB();

const app = express();
const server = http.createServer(app);

// WebSocket server setup
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors({
  origin: ['https://geofence-key-guard.netlify.app', 'http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy for accurate IP addresses
app.set('trust proxy', true);

// Store active WebSocket sessions and connections
const webSocketSessions = new Map(); // sessionId -> { desktopWs, mobileWs, authData }
const webSocketConnections = new Map(); // connectionId -> { ws, sessionId, type }

// WebSocket utility functions
const sendMessage = (ws, type, data) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
  }
};

const broadcastToSession = (sessionId, type, data, excludeWs = null) => {
  const session = webSocketSessions.get(sessionId);
  if (session) {
    if (session.desktopWs && session.desktopWs !== excludeWs) {
      sendMessage(session.desktopWs, type, data);
    }
    if (session.mobileWs && session.mobileWs !== excludeWs) {
      sendMessage(session.mobileWs, type, data);
    }
  }
};

// WebSocket handlers
function handleDesktopRegistration(ws, connectionId, data) {
  const { sessionId, userEmail, labName } = data;
  
  webSocketConnections.set(connectionId, { ws, sessionId, type: 'desktop' });
  
  if (!webSocketSessions.has(sessionId)) {
    webSocketSessions.set(sessionId, {
      desktopWs: ws,
      mobileWs: null,
      authData: null,
      userEmail,
      labName,
      createdAt: Date.now()
    });
  } else {
    webSocketSessions.get(sessionId).desktopWs = ws;
  }
  
  console.log(`Desktop registered for session: ${sessionId}`);
  sendMessage(ws, 'desktop_registered', { 
    sessionId, 
    status: 'waiting_for_mobile',
    message: 'QR code ready for scanning'
  });
}

function handleMobileRegistration(ws, connectionId, data) {
  const { sessionId, userEmail, challenge } = data;
  
  webSocketConnections.set(connectionId, { ws, sessionId, type: 'mobile' });
  
  if (webSocketSessions.has(sessionId)) {
    webSocketSessions.get(sessionId).mobileWs = ws;
    console.log(`Mobile registered for session: ${sessionId}`);
    
    sendMessage(ws, 'mobile_registered', { 
      sessionId,
      userEmail,
      challenge,
      message: 'Ready for passkey authentication'
    });
    
    broadcastToSession(sessionId, 'mobile_connected', { 
      message: 'Mobile device connected. Waiting for authentication...' 
    }, ws);
  } else {
    sendMessage(ws, 'error', { message: 'Invalid session ID' });
  }
}

function handlePasskeyAuthSuccess(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) return;
  
  const { sessionId } = connection;
  const { credential, userEmail, deviceInfo } = data;
  
  const session = webSocketSessions.get(sessionId);
  if (session) {
    session.authData = {
      success: true,
      credential,
      userEmail,
      deviceInfo,
      timestamp: Date.now(),
      type: 'authentication'
    };
    
    console.log(`Passkey authentication successful for session: ${sessionId}`);
    
    sendMessage(ws, 'auth_success_confirmed', {
      message: 'Authentication successful! Return to desktop.',
      sessionId
    });
    
    broadcastToSession(sessionId, 'passkey_verified', {
      message: 'Passkey authentication successful. Checking location...',
      authData: session.authData,
      nextStep: 'location_check'
    }, ws);
  }
}

function handlePasskeyCreated(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) return;
  
  const { sessionId } = connection;
  const { credential, userEmail, deviceInfo } = data;
  
  const session = webSocketSessions.get(sessionId);
  if (session) {
    session.authData = {
      success: true,
      credential,
      userEmail,
      deviceInfo,
      timestamp: Date.now(),
      type: 'creation'
    };
    
    console.log(`Passkey created for session: ${sessionId}`);
    
    sendMessage(ws, 'passkey_created_confirmed', {
      message: 'Passkey created successfully! Return to desktop.',
      sessionId
    });
    
    broadcastToSession(sessionId, 'passkey_created', {
      message: 'Passkey created successfully. Checking location...',
      authData: session.authData,
      nextStep: 'location_check'
    }, ws);
  }
}

function handleLocationCheckComplete(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) return;
  
  const { sessionId } = connection;
  const { success, distance, location, error } = data;
  
  console.log(`Location check complete for session: ${sessionId}`, { success, distance });
  
  if (success) {
    broadcastToSession(sessionId, 'access_granted', {
      message: 'Access granted! Welcome to the lab.',
      distance,
      location,
      redirectTo: '/dashboard/employee'
    });
  } else {
    broadcastToSession(sessionId, 'access_denied', {
      message: error || 'Access denied. Location check failed.',
      distance,
      location
    });
  }
}

function handleWebSocketDisconnection(connectionId) {
  const connection = webSocketConnections.get(connectionId);
  if (connection) {
    const { sessionId, type } = connection;
    console.log(`${type} disconnected from session: ${sessionId}`);
    
    const session = webSocketSessions.get(sessionId);
    if (session) {
      if (type === 'desktop') {
        session.desktopWs = null;
      } else if (type === 'mobile') {
        session.mobileWs = null;
      }
      
      // Clean up session after 5 minutes if both disconnected
      if (!session.desktopWs && !session.mobileWs) {
        setTimeout(() => {
          webSocketSessions.delete(sessionId);
          console.log(`WebSocket session ${sessionId} cleaned up`);
        }, 300000); // 5 minutes
      }
    }
    
    webSocketConnections.delete(connectionId);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const connectionId = uuidv4();
  console.log(`New WebSocket connection: ${connectionId}`);
  
  sendMessage(ws, 'connected', { connectionId });
  
  ws.on('message', (message) => {
    try {
      const { type, data } = JSON.parse(message);
      console.log(`Received message: ${type}`, data);
      
      switch (type) {
        case 'register_desktop':
          handleDesktopRegistration(ws, connectionId, data);
          break;
        case 'register_mobile':
          handleMobileRegistration(ws, connectionId, data);
          break;
        case 'passkey_auth_success':
          handlePasskeyAuthSuccess(ws, connectionId, data);
          break;
        case 'passkey_created':
          handlePasskeyCreated(ws, connectionId, data);
          break;
        case 'location_check_complete':
          handleLocationCheckComplete(ws, connectionId, data);
          break;
        case 'ping':
          sendMessage(ws, 'pong', { timestamp: Date.now() });
          break;
        default:
          console.log(`Unknown message type: ${type}`);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
      sendMessage(ws, 'error', { message: 'Invalid message format' });
    }
  });
  
  ws.on('close', () => {
    handleWebSocketDisconnection(connectionId);
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${connectionId}:`, error);
    handleWebSocketDisconnection(connectionId);
  });
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/realtime', require('./routes/realtime'));

// WebSocket session management endpoints
app.get('/api/websocket/sessions', (req, res) => {
  const sessionList = Array.from(webSocketSessions.entries()).map(([id, session]) => ({
    sessionId: id,
    hasDesktop: !!session.desktopWs,
    hasMobile: !!session.mobileWs,
    hasAuth: !!session.authData,
    userEmail: session.userEmail,
    createdAt: session.createdAt
  }));
  
  res.json({ sessions: sessionList });
});

app.post('/api/websocket/verify-session', (req, res) => {
  const { sessionId } = req.body;
  const session = webSocketSessions.get(sessionId);
  
  if (session) {
    res.json({
      valid: true,
      hasAuth: !!session.authData,
      userEmail: session.userEmail,
      labName: session.labName
    });
  } else {
    res.status(404).json({ valid: false, message: 'Session not found' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    features: {
      realTimeTracking: true,
      sessionManagement: true,
      geofenceMonitoring: true,
      webSocketAuth: true
    },
    webSocket: {
      activeSessions: webSocketSessions.size,
      activeConnections: webSocketConnections.size
    },
    uptime: process.uptime()
  });
});

// Root endpoint with comprehensive API documentation
app.get('/', (req, res) => {
  res.json({
    message: 'Unified Lab Management System API with WebSocket Authentication',
    version: '2.0.0',
    status: 'Running',
    webSocket: {
      endpoint: `ws://localhost:${process.env.PORT || 4000}`,
      activeSessions: webSocketSessions.size,
      activeConnections: webSocketConnections.size
    },
    endpoints: {
      health: '/api/health',
      auth: {
        register: 'POST /api/auth/register-lab',
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout',
        profile: 'GET /api/auth/profile',
        sessionHistory: 'GET /api/auth/session-history'
      },
      users: {
        createEmployee: 'POST /api/users/create-employee',
        listEmployees: 'GET /api/users/employees',
        updateEmployee: 'PUT /api/users/employees/:id',
        deleteEmployee: 'DELETE /api/users/employees/:id',
        loginAttempts: 'GET /api/users/login-attempts'
      },
      dashboard: {
        stats: 'GET /api/dashboard/stats',
        labInfo: 'GET /api/dashboard/lab-info'
      },
      realtime: {
        heartbeat: 'POST /api/realtime/heartbeat',
        logout: 'POST /api/realtime/logout',
        activeEmployees: 'GET /api/realtime/active-employees',
        employeeActivity: 'GET /api/realtime/employee-activity/:userId',
        sessionStats: 'GET /api/realtime/session-stats',
        dashboardSummary: 'GET /api/realtime/dashboard-summary',
        updateLocation: 'POST /api/realtime/update-location'
      },
      websocket: {
        sessions: 'GET /api/websocket/sessions',
        verifySession: 'POST /api/websocket/verify-session'
      }
    },
    documentation: 'Visit /api/health for server status'
  });
});

// Database session cleanup functions
const cleanupInactiveSessions = async () => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const inactiveSessions = await EmployeeSession.find({
      isActive: true,
      lastActivity: { $lt: fiveMinutesAgo }
    });

    let cleanedCount = 0;
    for (const session of inactiveSessions) {
      const duration = Math.round((new Date() - session.loginTime) / (1000 * 60));
      
      session.isActive = false;
      session.logoutTime = new Date();
      session.sessionDuration = duration;
      
      session.activityLog.push({
        timestamp: new Date(),
        action: 'timeout',
        metadata: {
          sessionDuration: duration,
          reason: 'inactivity_timeout',
          timeoutThreshold: 5
        }
      });

      await session.save();

      await new ActivityLog({
        userId: session.userId,
        labId: session.labId,
        sessionId: session._id,
        action: 'timeout',
        timestamp: new Date(),
        metadata: {
          sessionDuration: duration,
          reason: 'inactivity_timeout',
          timeoutThreshold: 5,
          lastActivity: session.lastActivity
        }
      }).save();

      cleanedCount++;
    }

    if (cleanedCount > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${cleanedCount} inactive database sessions`);
    }
  } catch (error) {
    console.error('Database session cleanup error:', error);
  }
};

const cleanupOldLogs = async () => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const deletedLogs = await ActivityLog.deleteMany({
      timestamp: { $lt: thirtyDaysAgo }
    });

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const deletedSessions = await EmployeeSession.deleteMany({
      isActive: false,
      logoutTime: { $lt: ninetyDaysAgo }
    });

    console.log(`[${new Date().toISOString()}] Daily cleanup: Removed ${deletedLogs.deletedCount} old activity logs and ${deletedSessions.deletedCount} old sessions`);
  } catch (error) {
    console.error('Daily cleanup error:', error);
  }
};

const cleanupOldWebSocketSessions = () => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  for (const [sessionId, session] of webSocketSessions.entries()) {
    if (session.createdAt < oneHourAgo) {
      webSocketSessions.delete(sessionId);
      console.log(`Cleaned up old WebSocket session: ${sessionId}`);
    }
  }
};

// Start cleanup intervals
setInterval(cleanupInactiveSessions, 5 * 60 * 1000); // Every 5 minutes
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000); // Every 24 hours
setInterval(cleanupOldWebSocketSessions, 60 * 60 * 1000); // Every hour

// Run initial cleanup on startup
setTimeout(cleanupInactiveSessions, 10000); // 10 seconds after startup

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n[${new Date().toISOString()}] Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Close all WebSocket connections
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    });

    // Mark all active database sessions as logged out
    const activeSessions = await EmployeeSession.find({ isActive: true });
    
    for (const session of activeSessions) {
      const duration = Math.round((new Date() - session.loginTime) / (1000 * 60));
      
      session.isActive = false;
      session.logoutTime = new Date();
      session.sessionDuration = duration;
      
      session.activityLog.push({
        timestamp: new Date(),
        action: 'logout',
        metadata: {
          sessionDuration: duration,
          reason: 'server_shutdown',
          signal: signal
        }
      });

      await session.save();

      await new ActivityLog({
        userId: session.userId,
        labId: session.labId,
        sessionId: session._id,
        action: 'timeout',
        timestamp: new Date(),
        metadata: {
          sessionDuration: duration,
          reason: 'server_shutdown',
          signal: signal
        }
      }).save();
    }

    console.log(`[${new Date().toISOString()}] Cleaned up ${activeSessions.length} active sessions due to shutdown`);
    
    // Close database connection
    const mongoose = require('mongoose');
    await mongoose.connection.close();
    console.log(`[${new Date().toISOString()}] Database connection closed`);
    
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
};

// Listen for shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    message: 'Route not found',
    availableEndpoints: [
      '/api/health',
      '/api/auth/*',
      '/api/users/*',
      '/api/dashboard/*',
      '/api/realtime/*',
      '/api/websocket/*'
    ]
  });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] 🚀 Unified Lab Management Server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] 🌐 HTTP API: http://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] 📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] Environment: ${process.env.NODE_ENV}`);
  console.log(`[${new Date().toISOString()}] Features: Real-time tracking, Session management, WebSocket auth`);
  console.log(`[${new Date().toISOString()}] Cleanup: DB sessions every 5min, Logs every 24h, WS sessions every 1h`);
});

module.exports = { app, server, wss };