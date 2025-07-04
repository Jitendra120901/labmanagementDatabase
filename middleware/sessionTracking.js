// middleware/sessionTracking.js
const EmployeeSession = require('../models/EmployeeSession');
const ActivityLog = require('../models/ActivityLog');
const { isWithinGeofence } = require('../utils/geofence');

// Middleware to track user activity on API calls
const trackActivity = async (req, res, next) => {
  // Only track authenticated users
  if (req.user) {
    try {
      const sessionToken = req.headers.authorization?.replace('Bearer ', '');
      
      if (sessionToken) {
        // Find active session
        const session = await EmployeeSession.findOne({ 
          sessionToken, 
          userId: req.user.id, 
          isActive: true 
        }).populate('labId');

        if (session) {
          // Update last activity timestamp
          session.lastActivity = new Date();
          
          // Prepare activity data
          const activityData = {
            userId: req.user.id,
            labId: req.user.labId,
            sessionId: session._id,
            action: 'api_call',
            timestamp: new Date(),
            metadata: {
              ipAddress: req.ip,
              userAgent: req.get('User-Agent'),
              endpoint: req.originalUrl,
              method: req.method,
              responseTime: null // Will be set in response middleware
            }
          };

          // Add location data if provided in request body
          if (req.body && req.body.latitude && req.body.longitude) {
            const location = {
              latitude: parseFloat(req.body.latitude),
              longitude: parseFloat(req.body.longitude)
            };
            
            activityData.location = location;
            
            // Update session location
            session.currentLocation = location;

            // Check geofence for employees
            if (req.user.role === 'lab_employee' && session.labId) {
              const geofenceCheck = isWithinGeofence(
                location,
                session.labId.location,
                session.labId.geofence.radius
              );
              
              activityData.distanceFromLab = geofenceCheck.distance;
              activityData.isWithinGeofence = geofenceCheck.isWithin;

              // Log geofence violation if outside bounds
              if (!geofenceCheck.isWithin) {
                await new ActivityLog({
                  ...activityData,
                  action: 'geofence_violation',
                  metadata: {
                    ...activityData.metadata,
                    violationDistance: geofenceCheck.distance,
                    allowedRadius: session.labId.geofence.radius
                  }
                }).save();
              }
            }
          }

          // Save session updates
          await session.save();

          // Store activity data in request for response middleware
          req.activityData = activityData;
        }
      }
    } catch (error) {
      console.error('Activity tracking error:', error);
      // Don't fail the request if tracking fails
    }
  }
  
  next();
};

// Response middleware to log API call completion
const logApiResponse = (req, res, next) => {
  if (req.activityData) {
    const originalSend = res.send;
    const startTime = Date.now();

    res.send = function(data) {
      // Calculate response time
      const responseTime = Date.now() - startTime;
      
      // Update activity metadata
      req.activityData.metadata.responseTime = responseTime;
      req.activityData.metadata.statusCode = res.statusCode;
      
      // Add error message if response indicates an error
      if (res.statusCode >= 400) {
        try {
          const responseData = typeof data === 'string' ? JSON.parse(data) : data;
          req.activityData.metadata.errorMessage = responseData.message || 'Unknown error';
        } catch (e) {
          req.activityData.metadata.errorMessage = 'Response parsing error';
        }
      }

      // Save activity log asynchronously (don't block response)
      setImmediate(async () => {
        try {
          await new ActivityLog(req.activityData).save();
        } catch (error) {
          console.error('Failed to save activity log:', error);
        }
      });

      // Call original send
      originalSend.call(this, data);
    };
  }
  
  next();
};

// Middleware to check session validity
const validateSession = async (req, res, next) => {
  if (req.user) {
    try {
      const sessionToken = req.headers.authorization?.replace('Bearer ', '');
      
      if (sessionToken) {
        const session = await EmployeeSession.findOne({
          sessionToken,
          userId: req.user.id,
          isActive: true
        });

        if (!session) {
          return res.status(401).json({ 
            message: 'Session expired or invalid',
            code: 'SESSION_EXPIRED'
          });
        }

        // Check if session is too old (24 hours)
        const sessionAge = Date.now() - session.loginTime.getTime();
        const maxSessionAge = 24 * 60 * 60 * 1000; // 24 hours

        if (sessionAge > maxSessionAge) {
          // Mark session as expired
          session.isActive = false;
          session.logoutTime = new Date();
          session.sessionDuration = Math.round(sessionAge / (1000 * 60));
          await session.save();

          return res.status(401).json({ 
            message: 'Session expired due to age',
            code: 'SESSION_EXPIRED'
          });
        }

        // Check if session has been inactive too long (6 hours)
        const inactiveTime = Date.now() - session.lastActivity.getTime();
        const maxInactiveTime = 6 * 60 * 60 * 1000; // 6 hours

        if (inactiveTime > maxInactiveTime) {
          // Mark session as expired due to inactivity
          session.isActive = false;
          session.logoutTime = new Date();
          session.sessionDuration = Math.round((session.lastActivity.getTime() - session.loginTime.getTime()) / (1000 * 60));
          await session.save();

          // Log timeout activity
          await new ActivityLog({
            userId: req.user.id,
            labId: req.user.labId,
            sessionId: session._id,
            action: 'timeout',
            timestamp: new Date(),
            metadata: {
              reason: 'max_inactivity_exceeded',
              inactiveMinutes: Math.round(inactiveTime / (1000 * 60)),
              maxInactiveMinutes: Math.round(maxInactiveTime / (1000 * 60))
            }
          }).save();

          return res.status(401).json({ 
            message: 'Session expired due to inactivity',
            code: 'SESSION_INACTIVE'
          });
        }

        // Attach session info to request
        req.session = session;
      }
    } catch (error) {
      console.error('Session validation error:', error);
      // Don't fail the request if validation fails
    }
  }
  
  next();
};

// Middleware to require active session for certain endpoints
const requireActiveSession = (req, res, next) => {
  if (req.user && req.user.role === 'lab_employee') {
    if (!req.session || !req.session.isActive) {
      return res.status(401).json({
        message: 'Active session required for lab employees',
        code: 'SESSION_REQUIRED'
      });
    }

    // Check if last heartbeat was too long ago (5 minutes)
    const lastHeartbeat = req.session.lastActivity;
    const heartbeatThreshold = 5 * 60 * 1000; // 5 minutes
    
    if (Date.now() - lastHeartbeat.getTime() > heartbeatThreshold) {
      return res.status(401).json({
        message: 'Session inactive - heartbeat required',
        code: 'HEARTBEAT_REQUIRED',
        lastActivity: lastHeartbeat
      });
    }
  }
  
  next();
};

// Combined middleware for comprehensive session tracking
const sessionTrackingMiddleware = [
  trackActivity,
  logApiResponse,
  validateSession
];

module.exports = {
  trackActivity,
  logApiResponse,
  validateSession,
  requireActiveSession,
  sessionTrackingMiddleware
};