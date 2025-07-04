const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Lab = require('../models/Lab');
const LoginAttempt = require('../models/LoginAttempt');
const EmployeeSession = require('../models/EmployeeSession');
const ActivityLog = require('../models/ActivityLog');
const { isWithinGeofence, validateLocation, formatDistance } = require('../utils/geofence');
const { auth, requireLabAdmin } = require('../middleware/auth');

const router = express.Router();

// Lab Registration
router.post('/register-lab', [
  body('name').trim().isLength({ min: 2 }).withMessage('Lab name must be at least 2 characters'),
  body('address').trim().isLength({ min: 5 }).withMessage('Address must be at least 5 characters'),
  body('phone').trim().matches(/^\+?[\d\s-()]+$/).withMessage('Invalid phone number'),
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  body('registrationNumber').trim().isLength({ min: 3 }).withMessage('Registration number required'),
  body('adminName').trim().isLength({ min: 2 }).withMessage('Admin name must be at least 2 characters'),
  body('adminEmail').isEmail().normalizeEmail().withMessage('Invalid admin email'),
  body('adminPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      name, address, phone, email, registrationNumber,
      adminName, adminEmail, adminPassword, latitude, longitude
    } = req.body;

    // Check if lab already exists
    const existingLab = await Lab.findOne({
      $or: [
        { email: email },
        { registrationNumber: registrationNumber },
        { adminEmail: adminEmail }
      ]
    });

    if (existingLab) {
      return res.status(400).json({ message: 'Lab or admin already exists' });
    }

    // Hash admin password
    const hashedPassword = await bcrypt.hash(adminPassword, 12);

    // Create lab
    const lab = new Lab({
      name,
      address,
      phone,
      email,
      registrationNumber,
      adminName,
      adminEmail,
      adminPassword: hashedPassword,
      location: {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude)
      }
    });

    await lab.save();

    // Create admin user
    const adminUser = new User({
      name: adminName,
      email: adminEmail,
      password: hashedPassword,
      phone: phone,
      employeeId: `ADMIN_${registrationNumber}`,
      role: 'lab_admin',
      labId: lab._id,
      department: 'Administration',
      designation: 'Lab Administrator'
    });

    await adminUser.save();

    res.status(201).json({
      message: 'Lab registered successfully',
      labId: lab._id,
      adminUserId: adminUser._id
    });

  } catch (error) {
    console.error('Lab registration error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// User Login with Geofence Check and Session Tracking
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  body('password').exists().withMessage('Password required'),
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, latitude, longitude } = req.body;
    const userLocation = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };

    // Find user
    const user = await User.findOne({ email, isActive: true }).populate('labId');
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      // Log failed attempt
      const failedAttempt = new LoginAttempt({
        userId: user._id,
        labId: user.labId._id,
        attemptLocation: userLocation,
        isSuccessful: false,
        isWithinGeofence: false,
        distanceFromLab: 0,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        failureReason: 'invalid_credentials'
      });
      
      await failedAttempt.save();
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check geofence for lab employees (lab admins can login from anywhere)
    if (user.role === 'lab_employee') {
      try {
        const geofenceCheck = isWithinGeofence(
          userLocation,
          user.labId.location,
          user.labId.geofence.radius
        );

        // Log attempt
        const attemptData = {
          userId: user._id,
          labId: user.labId._id,
          attemptLocation: userLocation,
          isSuccessful: geofenceCheck.isWithin,
          isWithinGeofence: geofenceCheck.isWithin,
          distanceFromLab: geofenceCheck.distance,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        };

        // Only add failureReason if login failed
        if (!geofenceCheck.isWithin) {
          attemptData.failureReason = 'outside_geofence';
        }

        const loginAttempt = new LoginAttempt(attemptData);
        await loginAttempt.save();

        if (!geofenceCheck.isWithin) {
          return res.status(403).json({
            message: 'Access denied. You must be within the lab premises to login.',
            distance: formatDistance(geofenceCheck.distance),
            distanceInMeters: geofenceCheck.distance,
            allowedRadius: formatDistance(user.labId.geofence.radius),
            allowedRadiusInMeters: user.labId.geofence.radius,
            bearing: geofenceCheck.bearing
          });
        }
      } catch (geofenceError) {
        console.error('Geofence calculation error:', geofenceError);
        return res.status(400).json({
          message: 'Invalid location data provided',
          error: geofenceError.message
        });
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id, role: user.role, labId: user.labId._id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Generate unique session token for real-time tracking
    const sessionToken = token; // Use JWT token as session token

    // Extract device information
    const userAgent = req.get('User-Agent') || '';
    const deviceInfo = {
      userAgent: userAgent,
      ipAddress: req.ip,
      browser: userAgent.split(' ')[0] || 'Unknown',
      os: userAgent.includes('Mac') ? 'macOS' : 
          userAgent.includes('Windows') ? 'Windows' : 
          userAgent.includes('Linux') ? 'Linux' : 'Unknown'
    };

    // Close any existing active sessions for this user
    // FIXED: Calculate session duration properly for bulk update
    const currentTime = new Date();
    const activeSessions = await EmployeeSession.find({
      userId: user._id,
      isActive: true
    });

    // Update each session individually to calculate duration properly
    for (const session of activeSessions) {
      const duration = Math.round((currentTime - session.loginTime) / (1000 * 60));
      session.isActive = false;
      session.logoutTime = currentTime;
      session.sessionDuration = duration;
      await session.save();
    }

    // Create new employee session for real-time tracking
    const session = new EmployeeSession({
      userId: user._id,
      labId: user.labId._id,
      sessionToken: sessionToken,
      loginTime: new Date(),
      lastActivity: new Date(),
      currentLocation: userLocation,
      isActive: true,
      deviceInfo: deviceInfo,
      activityLog: [{
        timestamp: new Date(),
        action: 'login',
        location: userLocation,
        metadata: deviceInfo
      }]
    });

    await session.save();

    // Log login activity in ActivityLog
    let distanceFromLab = 0;
    let isWithinGeofenceForLog = true;
    
    if (user.role === 'lab_employee') {
      try {
        const geofenceCheck = isWithinGeofence(userLocation, user.labId.location, user.labId.geofence.radius);
        distanceFromLab = geofenceCheck.distance;
        isWithinGeofenceForLog = geofenceCheck.isWithin;
      } catch (error) {
        console.error('Geofence check error in activity log:', error);
      }
    }

    await new ActivityLog({
      userId: user._id,
      labId: user.labId._id,
      sessionId: session._id,
      action: 'login',
      timestamp: new Date(),
      location: userLocation,
      distanceFromLab: distanceFromLab,
      isWithinGeofence: isWithinGeofenceForLog,
      metadata: {
        ...deviceInfo,
        endpoint: '/api/auth/login',
        loginMethod: 'credentials'
      }
    }).save();

    // Log successful login attempt (for non-employees or employees within geofence)
    if (user.role === 'lab_admin') {
      const adminAttempt = new LoginAttempt({
        userId: user._id,
        labId: user.labId._id,
        attemptLocation: userLocation,
        isSuccessful: true,
        isWithinGeofence: true, // Admin can login from anywhere
        distanceFromLab: 0,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
        // No failureReason for successful logins
      });
      
      await adminAttempt.save();
    }

    // Update last login information
    user.lastLogin = new Date();
    user.lastLoginLocation = userLocation;
    await user.save();

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        lab: {
          id: user.labId._id,
          name: user.labId.name
        }
      },
      session: {
        id: session._id,
        loginTime: session.loginTime,
        isRealTimeTrackingEnabled: true
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout endpoint with session cleanup
router.post('/logout', auth, async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');

    if (sessionToken) {
      const session = await EmployeeSession.findOne({
        sessionToken,
        userId: req.user.id,
        isActive: true
      });

      if (session) {
        // Calculate session duration
        const duration = Math.round((new Date() - session.loginTime) / (1000 * 60)); // minutes
        
        session.isActive = false;
        session.logoutTime = new Date();
        session.sessionDuration = duration;
        
        // Add logout to activity log
        session.activityLog.push({
          timestamp: new Date(),
          action: 'logout',
          metadata: {
            sessionDuration: duration,
            logoutMethod: 'manual'
          }
        });

        await session.save();

        // Log logout activity
        await new ActivityLog({
          userId: req.user.id,
          labId: req.user.labId,
          sessionId: session._id,
          action: 'manual_logout',
          timestamp: new Date(),
          metadata: {
            sessionDuration: duration,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            endpoint: '/api/auth/logout'
          }
        }).save();
      }
    }

    res.json({ 
      message: 'Logged out successfully',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user profile with session info
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('labId', 'name address phone email location geofence')
      .select('-password');
    
    // Get current active session
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');
    const currentSession = await EmployeeSession.findOne({
      sessionToken,
      userId: req.user.id,
      isActive: true
    });

    const response = {
      ...user.toObject(),
      currentSession: currentSession ? {
        id: currentSession._id,
        loginTime: currentSession.loginTime,
        lastActivity: currentSession.lastActivity,
        sessionDuration: currentSession.loginTime ? 
          Math.round((new Date() - currentSession.loginTime) / (1000 * 60)) : 0,
        currentLocation: currentSession.currentLocation,
        isActive: currentSession.isActive
      } : null
    };
    
    res.json(response);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user's session history
router.get('/session-history', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10, startDate, endDate } = req.query;

    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = {
        loginTime: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      };
    }

    const sessions = await EmployeeSession.find({
      userId: req.user.id,
      ...dateFilter
    })
    .sort({ loginTime: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .select('-activityLog'); // Exclude detailed activity log for performance

    const total = await EmployeeSession.countDocuments({
      userId: req.user.id,
      ...dateFilter
    });

    const sessionsWithDuration = sessions.map(session => ({
      ...session.toObject(),
      calculatedDuration: session.sessionDuration || 
        (session.logoutTime ? 
          Math.round((session.logoutTime - session.loginTime) / (1000 * 60)) :
          Math.round((new Date() - session.loginTime) / (1000 * 60)))
    }));

    res.json({
      sessions: sessionsWithDuration,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });

  } catch (error) {
    console.error('Session history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;