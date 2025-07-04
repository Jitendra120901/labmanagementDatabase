const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/database');

// Import models for session cleanup
const EmployeeSession = require('./models/EmployeeSession');
const ActivityLog = require('./models/ActivityLog');

// Load environment variables
dotenv.config();

// Connect to database
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy for accurate IP addresses
app.set('trust proxy', true);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/realtime', require('./routes/realTime'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    features: {
      realTimeTracking: true,
      sessionManagement: true,
      geofenceMonitoring: true
    }
  });
});

// Root endpoint with API documentation
app.get('/', (req, res) => {
  res.json({
    message: 'Lab Management System API',
    version: '1.0.0',
    status: 'Running',
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
      }
    },
    documentation: 'Visit /api/health for server status'
  });
});

// Session cleanup job - runs every 5 minutes
const cleanupInactiveSessions = async () => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    // Find sessions that haven't been active for 5+ minutes
    const inactiveSessions = await EmployeeSession.find({
      isActive: true,
      lastActivity: { $lt: fiveMinutesAgo }
    });

    let cleanedCount = 0;
    for (const session of inactiveSessions) {
      const duration = Math.round((new Date() - session.loginTime) / (1000 * 60));
      
      // Update session as inactive
      session.isActive = false;
      session.logoutTime = new Date();
      session.sessionDuration = duration;
      
      // Add timeout activity to session log
      session.activityLog.push({
        timestamp: new Date(),
        action: 'timeout',
        metadata: {
          sessionDuration: duration,
          reason: 'inactivity_timeout',
          timeoutThreshold: 5 // minutes
        }
      });

      await session.save();

      // Log timeout activity
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
      console.log(`[${new Date().toISOString()}] Cleaned up ${cleanedCount} inactive sessions`);
    }
  } catch (error) {
    console.error('Session cleanup error:', error);
  }
};

// Old activity log cleanup - runs daily
const cleanupOldLogs = async () => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Remove activity logs older than 30 days
    const deletedLogs = await ActivityLog.deleteMany({
      timestamp: { $lt: thirtyDaysAgo }
    });

    // Remove old completed sessions (older than 90 days)
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

// Start cleanup intervals
setInterval(cleanupInactiveSessions, 5 * 60 * 1000); // Every 5 minutes
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000); // Every 24 hours

// Run initial cleanup on startup (after a delay to ensure DB is connected)
setTimeout(cleanupInactiveSessions, 10000); // 10 seconds after startup

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n[${new Date().toISOString()}] Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Mark all active sessions as logged out due to server shutdown
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

      // Log shutdown activity
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
      '/api/realtime/*'
    ]
  });
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Environment: ${process.env.NODE_ENV}`);
  console.log(`[${new Date().toISOString()}] Real-time tracking: ENABLED`);
  console.log(`[${new Date().toISOString()}] Session cleanup: Every 5 minutes`);
  console.log(`[${new Date().toISOString()}] Log cleanup: Every 24 hours`);
});

module.exports = app;