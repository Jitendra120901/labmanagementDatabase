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

// Updated Lab Registration route in routes/auth.js
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
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('geofenceRadius').optional().isInt({ min: 20, max: 1000 }).withMessage('Geofence radius must be between 20 and 1000 meters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      name, address, phone, email, registrationNumber,
      adminName, adminEmail, adminPassword, latitude, longitude, geofenceRadius
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

    // Create lab with custom geofence radius
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
      },
      geofence: {
        radius: parseInt(geofenceRadius) || 100, // Default to 100m if not provided
        updatedAt: new Date()
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
      adminUserId: adminUser._id,
      geofenceRadius: lab.geofence.radius
    });

  } catch (error) {
    console.error('Lab registration error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// User Login with Geofence Check and Session Tracking
// Enhanced login route with GPS accuracy handling
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  body('password').exists().withMessage('Password required'),
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('accuracy').optional().isFloat({ min: 0, max: 1000 }).withMessage('Invalid GPS accuracy')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, latitude, longitude, accuracy } = req.body;
    const userLocation = { 
      latitude: parseFloat(latitude), 
      longitude: parseFloat(longitude),
      accuracy: accuracy ? parseFloat(accuracy) : null 
    };

    // Find user
    const user = await User.findOne({ email, isActive: true }).populate('labId');
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check geofence for lab employees with GPS accuracy consideration
    if (user.role === 'lab_employee') {
      try {
        const geofenceCheck = isWithinGeofence(
          userLocation,
          user.labId.location,
          user.labId.geofence.radius
        );

        // Log attempt with GPS accuracy info
        const attemptData = {
          userId: user._id,
          labId: user.labId._id,
          attemptLocation: userLocation,
          isSuccessful: geofenceCheck.isWithin,
          isWithinGeofence: geofenceCheck.isWithin,
          distanceFromLab: geofenceCheck.distance,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          metadata: {
            gpsAccuracy: userLocation.accuracy,
            effectiveRadius: geofenceCheck.effectiveRadius,
            gpsBuffer: geofenceCheck.gpsAccuracyBuffer,
            isWithinOriginalRadius: geofenceCheck.isWithinOriginalRadius,
            isWithinGPSBuffer: geofenceCheck.isWithinGPSBuffer
          }
        };

        if (!geofenceCheck.isWithin) {
          attemptData.failureReason = 'outside_geofence';
        }

        const loginAttempt = new LoginAttempt(attemptData);
        await loginAttempt.save();

        if (!geofenceCheck.isWithin) {
          const responseData = {
            message: 'Access denied. You must be within the lab premises to login.',
            distance: formatDistance(geofenceCheck.distance),
            distanceInMeters: geofenceCheck.distance,
            allowedRadius: formatDistance(user.labId.geofence.radius),
            allowedRadiusInMeters: user.labId.geofence.radius,
            effectiveRadius: formatDistance(geofenceCheck.effectiveRadius),
            effectiveRadiusInMeters: geofenceCheck.effectiveRadius,
            gpsAccuracyBuffer: geofenceCheck.gpsAccuracyBuffer,
            gpsAccuracyNote: "Distance calculation includes GPS accuracy buffer",
            recommendations: [
              "Move closer to the lab center",
              "Try logging in from a different location within the lab",
              "Ensure GPS is enabled and wait for better signal",
              "Contact admin if you're inside the lab premises"
            ]
          };
          
          if (geofenceCheck.bearing !== null) {
            responseData.bearing = geofenceCheck.bearing;
          }
          
          return res.status(403).json(responseData);
        }

        // Log success with GPS buffer info
        if (geofenceCheck.isWithinGPSBuffer) {
          console.log(`Employee ${user.email} logged in using GPS accuracy buffer. Distance: ${geofenceCheck.distance}m, Original radius: ${user.labId.geofence.radius}m`);
        }

      } catch (geofenceError) {
        console.error('Geofence calculation error:', geofenceError);
        return res.status(400).json({
          message: 'Invalid location data provided',
          error: geofenceError.message
        });
      }
    }

    // Rest of login logic remains the same...
    // Generate JWT token, create session, etc.
    const token = jwt.sign(
      { id: user._id, role: user.role, labId: user.labId._id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

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
      locationInfo: user.role === 'lab_employee' ? {
        distance: formatDistance(geofenceCheck.distance),
        withinOriginalRadius: geofenceCheck.isWithinOriginalRadius,
        usedGPSBuffer: geofenceCheck.isWithinGPSBuffer
      } : null
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