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
    try {
      ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
      console.log(`📤 Sent ${type} message:`, data);
    } catch (error) {
      console.error(`❌ Error sending ${type} message:`, error);
    }
  } else {
    console.warn(`⚠️ Cannot send ${type} message - WebSocket not ready`);
  }
};

const broadcastToSession = (sessionId, type, data, excludeWs = null) => {
  const session = webSocketSessions.get(sessionId);
  if (session) {
    console.log(`📡 Broadcasting ${type} to session ${sessionId}`);
    if (session.desktopWs && session.desktopWs !== excludeWs) {
      sendMessage(session.desktopWs, type, data);
    }
    if (session.mobileWs && session.mobileWs !== excludeWs) {
      sendMessage(session.mobileWs, type, data);
    }
  } else {
    console.warn(`⚠️ Session ${sessionId} not found for broadcast`);
  }
};

// WebSocket handlers
function handleDesktopRegistration(ws, connectionId, data) {
  const { sessionId, userEmail, labName } = data;
  
  console.log(`🖥️ Desktop registration for session: ${sessionId}`);
  
  webSocketConnections.set(connectionId, { ws, sessionId, type: 'desktop' });
  
  if (!webSocketSessions.has(sessionId)) {
    webSocketSessions.set(sessionId, {
      desktopWs: ws,
      mobileWs: null,
      authData: null,
      userEmail,
      labName,
      requireLocation: true, // Default to true for login
      createdAt: Date.now()
    });
  } else {
    webSocketSessions.get(sessionId).desktopWs = ws;
  }
  
  console.log(`✅ Desktop registered for session: ${sessionId}`);
  sendMessage(ws, 'desktop_registered', { 
    sessionId, 
    status: 'waiting_for_mobile',
    message: 'QR code ready for scanning'
  });
}

function handleMobileRegistration(ws, connectionId, data) {
  const { sessionId, userEmail, challenge, requireLocation, mode } = data;
  
  console.log(`📱 Mobile registration for session: ${sessionId}`);
  console.log(`📱 Registration data:`, { userEmail, mode, requireLocation });
  
  webSocketConnections.set(connectionId, { ws, sessionId, type: 'mobile' });
  
  if (webSocketSessions.has(sessionId)) {
    const session = webSocketSessions.get(sessionId);
    session.mobileWs = ws;
    session.requireLocation = requireLocation !== undefined ? requireLocation : true; // Default to true
    session.mode = mode || 'login';
    
    console.log(`✅ Mobile registered for session: ${sessionId}, requireLocation: ${session.requireLocation}`);
    
    sendMessage(ws, 'mobile_registered', { 
      sessionId,
      userEmail,
      challenge,
      requireLocation: session.requireLocation,
      mode: session.mode,
      message: 'Ready for passkey authentication'
    });
    
    broadcastToSession(sessionId, 'mobile_connected', { 
      message: 'Mobile device connected. Waiting for authentication...',
      requireLocation: session.requireLocation,
      mode: session.mode
    }, ws);
  } else {
    console.error(`❌ Invalid session ID: ${sessionId}`);
    sendMessage(ws, 'error', { message: 'Invalid session ID' });
  }
}

function handlePasskeyAuthSuccess(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) {
    console.error(`❌ Connection not found for ID: ${connectionId}`);
    return;
  }
  
  const { sessionId } = connection;
  const { authData } = data;
  
  console.log(`🔐 Passkey authentication successful for session: ${sessionId}`);
  console.log(`🔐 Received data:`, JSON.stringify(data, null, 2));
  console.log(`🔐 Received authData:`, authData);
  
  if (!authData) {
    console.error(`❌ No authData received for session: ${sessionId}`);
    console.error(`❌ Full data object:`, data);
    sendMessage(ws, 'error', { message: 'No authentication data received' });
    return;
  }
  
  // SKIP CREDENTIAL VALIDATION FOR NOW - Just proceed with authentication
  console.log(`✅ Skipping credential validation - proceeding with authentication flow`);
  
  const session = webSocketSessions.get(sessionId);
  if (session) {
    session.authData = {
      success: true,
      credential: authData.credential || 'test-credential-id',
      userEmail: authData.userEmail || session.userEmail,
      deviceInfo: authData.deviceInfo || { platform: 'test', timestamp: Date.now() },
      timestamp: Date.now(),
      type: 'authentication'
    };
    
    console.log(`✅ Auth data stored for session: ${sessionId}`);
    
    // Send confirmation to mobile
    sendMessage(ws, 'passkey_verified_confirmed', {
      message: 'Authentication successful!',
      sessionId,
      requireLocation: session.requireLocation
    });
    
    // Notify desktop about successful authentication
    if (session.desktopWs) {
      sendMessage(session.desktopWs, 'passkey_verified', {
        message: 'Passkey authentication successful. Checking location...',
        authData: session.authData,
        nextStep: 'location_check',
        requireLocation: session.requireLocation
      });
      
      // If location is required, desktop should now request location
      if (session.requireLocation) {
        console.log(`📍 Location required for session ${sessionId}, desktop should request location`);
        
        // Send location request instruction to desktop
        sendMessage(session.desktopWs, 'request_location_from_mobile', {
          sessionId,
          authData: session.authData,
          message: 'Please request location from mobile device'
        });
      } else {
        // No location required, proceed with access granted
        console.log(`✅ No location required for session ${sessionId}, granting access`);
        broadcastToSession(sessionId, 'access_granted', {
          message: 'Access granted! Welcome to the lab.',
          authData: session.authData,
          redirectTo: '/dashboard/employee'
        });
      }
    }
  } else {
    console.error(`❌ Session not found: ${sessionId}`);
    sendMessage(ws, 'error', { message: 'Session not found' });
  }
}

function handlePasskeyCreated(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) {
    console.error(`❌ Connection not found for ID: ${connectionId}`);
    return;
  }
  
  const { sessionId } = connection;
  const { authData } = data;
  
  console.log(`🆕 Passkey created for session: ${sessionId}`);
  console.log(`🆕 Received data:`, JSON.stringify(data, null, 2));
  console.log(`🆕 Received authData:`, authData);
  
  if (!authData) {
    console.error(`❌ No authData received for session: ${sessionId}`);
    console.error(`❌ Full data object:`, data);
    sendMessage(ws, 'error', { message: 'No authentication data received' });
    return;
  }
  
  // SKIP CREDENTIAL VALIDATION FOR NOW - Just proceed with authentication
  console.log(`✅ Skipping credential validation - proceeding with passkey creation flow`);
  
  const session = webSocketSessions.get(sessionId);
  if (session) {
    session.authData = {
      success: true,
      credential: authData.credential || 'test-credential-id',
      userEmail: authData.userEmail || session.userEmail,
      deviceInfo: authData.deviceInfo || { platform: 'test', timestamp: Date.now() },
      timestamp: Date.now(),
      type: 'creation'
    };
    
    console.log(`✅ Creation data stored for session: ${sessionId}`);
    
    // Send confirmation to mobile
    sendMessage(ws, 'passkey_created_confirmed', {
      message: 'Passkey created successfully!',
      sessionId,
      requireLocation: session.requireLocation
    });
    
    // Notify desktop about successful passkey creation
    if (session.desktopWs) {
      sendMessage(session.desktopWs, 'passkey_created', {
        message: 'Passkey created successfully. Checking location...',
        authData: session.authData,
        nextStep: 'location_check',
        requireLocation: session.requireLocation
      });
      
      // If location is required, desktop should now request location
      if (session.requireLocation) {
        console.log(`📍 Location required for session ${sessionId}, desktop should request location`);
        
        // Send location request instruction to desktop
        sendMessage(session.desktopWs, 'request_location_from_mobile', {
          sessionId,
          authData: session.authData,
          message: 'Please request location from mobile device'
        });
      } else {
        // No location required, proceed with access granted
        console.log(`✅ No location required for session ${sessionId}, granting access`);
        broadcastToSession(sessionId, 'access_granted', {
          message: 'Access granted! Welcome to the lab.',
          authData: session.authData,
          redirectTo: '/dashboard/employee'
        });
      }
    }
  } else {
    console.error(`❌ Session not found: ${sessionId}`);
    sendMessage(ws, 'error', { message: 'Session not found' });
  }
}

// Handle location request from desktop
function handleLocationRequest(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) {
    console.error(`❌ Connection not found for ID: ${connectionId}`);
    return;
  }
  
  const { sessionId } = connection;
  const { authData, requestId } = data;
  
  console.log(`🖥️ Desktop requesting location for session: ${sessionId}, requestId: ${requestId}`);
  
  const session = webSocketSessions.get(sessionId);
  if (session && session.mobileWs) {
    console.log(`📍 Forwarding location request to mobile for session: ${sessionId}`);
    
    // Forward location request to mobile device
    sendMessage(session.mobileWs, 'request_location', {
      sessionId,
      authData,
      requestId,
      message: 'Desktop requesting location data'
    });
    
    console.log(`✅ Location request forwarded to mobile for session: ${sessionId}`);
  } else {
    console.error(`❌ Mobile device not connected for session: ${sessionId}`);
    sendMessage(ws, 'error', { 
      message: 'Mobile device not connected',
      sessionId 
    });
  }
}

// Handle location data received from mobile
function handleLocationReceived(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) {
    console.error(`❌ Connection not found for ID: ${connectionId}`);
    return;
  }
  
  const { sessionId } = connection;
  const { location, authData } = data;
  
  console.log(`📱 Location received from mobile for session: ${sessionId}:`, {
    lat: location.latitude,
    lng: location.longitude,
    accuracy: location.accuracy
  });
  
  const session = webSocketSessions.get(sessionId);
  if (session && session.desktopWs) {
    console.log(`📍 Forwarding location data to desktop for session: ${sessionId}`);
    
    // Store location data in session
    session.locationData = location;
    
    // Forward location data to desktop
    sendMessage(session.desktopWs, 'location_received', {
      sessionId,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        altitude: location.altitude,
        timestamp: location.timestamp
      },
      authData,
      message: 'Location data received from mobile device'
    });
    
    console.log(`✅ Location data forwarded to desktop for session: ${sessionId}`);
  } else {
    console.error(`❌ Desktop not connected for session: ${sessionId}`);
    sendMessage(ws, 'error', { 
      message: 'Desktop not connected',
      sessionId 
    });
  }
}

function handleLocationCheckComplete(ws, connectionId, data) {
  const connection = webSocketConnections.get(connectionId);
  if (!connection) {
    console.error(`❌ Connection not found for ID: ${connectionId}`);
    return;
  }
  
  const { sessionId } = connection;
  const { success, distance, location, error } = data;
  
  console.log(`🎯 Location check complete for session: ${sessionId}`, { 
    success, 
    distance: distance ? `${distance}m` : 'N/A' 
  });
  
  const session = webSocketSessions.get(sessionId);
  if (session) {
    // Store final result in session
    session.locationCheckResult = { success, distance, location, error };
    
    if (success) {
      console.log(`✅ Access granted for session: ${sessionId}`);
      broadcastToSession(sessionId, 'access_granted', {
        message: 'Access granted! Welcome to the lab.',
        distance,
        location,
        authData: session.authData,
        redirectTo: '/dashboard/employee'
      });
      
      // Send final success to mobile
      if (session.mobileWs) {
        sendMessage(session.mobileWs, 'location_check_complete', {
          success: true,
          distance,
          location,
          message: 'Location verified successfully!'
        });
      }
    } else {
      console.log(`❌ Access denied for session: ${sessionId}: ${error}`);
      broadcastToSession(sessionId, 'access_denied', {
        message: error || 'Access denied. Location check failed.',
        distance,
        location,
        authData: session.authData
      });
      
      // Send failure to mobile
      if (session.mobileWs) {
        sendMessage(session.mobileWs, 'location_check_complete', {
          success: false,
          distance,
          location,
          error: error || 'Location check failed',
          message: 'Location verification failed'
        });
      }
    }
  } else {
    console.error(`❌ Session not found for location check: ${sessionId}`);
  }
}

function handleWebSocketDisconnection(connectionId) {
  const connection = webSocketConnections.get(connectionId);
  if (connection) {
    const { sessionId, type } = connection;
    console.log(`🔌 ${type} disconnected from session: ${sessionId}`);
    
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
          if (webSocketSessions.has(sessionId)) {
            webSocketSessions.delete(sessionId);
            console.log(`🧹 WebSocket session ${sessionId} cleaned up`);
          }
        }, 300000); // 5 minutes
      }
    }
    
    webSocketConnections.delete(connectionId);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const connectionId = uuidv4();
  console.log(`🔗 New WebSocket connection: ${connectionId}`);
  
  sendMessage(ws, 'connected', { connectionId });
  
  ws.on('message', (message) => {
    try {
      const { type, data } = JSON.parse(message);
      console.log(`📥 Received message: ${type} from ${connectionId}`);
      
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
        case 'request_location':
          handleLocationRequest(ws, connectionId, data);
          break;
        case 'location_received':
          handleLocationReceived(ws, connectionId, data);
          break;
        case 'location_check_complete':
          handleLocationCheckComplete(ws, connectionId, data);
          break;
        case 'ping':
          sendMessage(ws, 'pong', { timestamp: Date.now() });
          break;
        default:
          console.warn(`❓ Unknown message type: ${type}`);
          sendMessage(ws, 'error', { message: `Unknown message type: ${type}` });
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
      sendMessage(ws, 'error', { message: 'Invalid message format' });
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 WebSocket connection closed: ${connectionId}`);
    handleWebSocketDisconnection(connectionId);
  });
  
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${connectionId}:`, error);
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
    hasLocation: !!session.locationData,
    userEmail: session.userEmail,
    requireLocation: session.requireLocation,
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
      hasLocation: !!session.locationData,
      requireLocation: session.requireLocation,
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
      webSocketAuth: true,
      locationForwarding: true
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
    version: '2.3.0',
    status: 'Running',
    webSocket: {
      endpoint: `ws://localhost:${process.env.PORT || 4000}`,
      activeSessions: webSocketSessions.size,
      activeConnections: webSocketConnections.size,
      supportedMessages: [
        'register_desktop',
        'register_mobile', 
        'passkey_auth_success',
        'passkey_created',
        'request_location',
        'location_received',
        'location_check_complete',
        'ping'
      ]
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
      console.log(`🧹 Cleaned up old WebSocket session: ${sessionId}`);
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
  console.log(`[${new Date().toISOString()}] Features: Real-time tracking, Session management, WebSocket auth, Location forwarding`);
  console.log(`[${new Date().toISOString()}] Cleanup: DB sessions every 5min, Logs every 24h, WS sessions every 1h`);
  console.log(`[${new Date().toISOString()}] WebSocket Messages: register_desktop, register_mobile, passkey_auth_success, passkey_created, request_location, location_received`);
});

module.exports = { app, server, wss };