const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Lab = require('../models/Lab');
const LoginAttempt = require('../models/LoginAttempt');
const { isWithinGeofence, validateLocation } = require('../utils/geofence');
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

// User Login with Geofence Check
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
      await new LoginAttempt({
        userId: user._id,
        labId: user.labId._id,
        attemptLocation: userLocation,
        isSuccessful: false,
        isWithinGeofence: false,
        distanceFromLab: 0,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        failureReason: 'invalid_credentials'
      }).save();

      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check geofence for lab employees (lab admins can login from anywhere)
    if (user.role === 'lab_employee') {
      const geofenceCheck = isWithinGeofence(
        userLocation,
        user.labId.location,
        user.labId.geofence.radius
      );

      // Log attempt
      await new LoginAttempt({
        userId: user._id,
        labId: user.labId._id,
        attemptLocation: userLocation,
        isSuccessful: geofenceCheck.isWithin,
        isWithinGeofence: geofenceCheck.isWithin,
        distanceFromLab: geofenceCheck.distance,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        failureReason: geofenceCheck.isWithin ? null : 'outside_geofence'
      }).save();

      if (!geofenceCheck.isWithin) {
        return res.status(403).json({
          message: 'Access denied. You must be within the lab premises to login.',
          distance: geofenceCheck.distance,
          allowedRadius: user.labId.geofence.radius
        });
      }
    } else {
      // Log successful admin login
      await new LoginAttempt({
        userId: user._id,
        labId: user.labId._id,
        attemptLocation: userLocation,
        isSuccessful: true,
        isWithinGeofence: true, // Admin can login from anywhere
        distanceFromLab: 0,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      }).save();
    }

    // Update last login
    user.lastLogin = new Date();
    user.lastLoginLocation = userLocation;
    await user.save();

    // Generate token
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
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('labId', 'name address phone email')
      .select('-password');
    
    res.json(user);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;