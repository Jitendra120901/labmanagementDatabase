const express = require('express');
const User = require('../models/User');
const Lab = require('../models/Lab');
const LoginAttempt = require('../models/LoginAttempt');
const { auth, requireLabAdmin } = require('../middleware/auth');

const router = express.Router();

// Get dashboard stats (only lab admin can access)
router.get('/stats', auth, requireLabAdmin, async (req, res) => {
  try {
    const labId = req.user.labId;

    // Get total employees
    const totalEmployees = await User.countDocuments({
      labId: labId,
      role: 'lab_employee'
    });

    // Get active employees
    const activeEmployees = await User.countDocuments({
      labId: labId,
      role: 'lab_employee',
      isActive: true
    });

    // Get total login attempts today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayLoginAttempts = await LoginAttempt.countDocuments({
      labId: labId,
      timestamp: { $gte: today, $lt: tomorrow }
    });

    // Get successful logins today
    const todaySuccessfulLogins = await LoginAttempt.countDocuments({
      labId: labId,
      isSuccessful: true,
      timestamp: { $gte: today, $lt: tomorrow }
    });

    // Get failed logins today
    const todayFailedLogins = await LoginAttempt.countDocuments({
      labId: labId,
      isSuccessful: false,
      timestamp: { $gte: today, $lt: tomorrow }
    });

    // Get geofence violations today
    const todayGeofenceViolations = await LoginAttempt.countDocuments({
      labId: labId,
      isWithinGeofence: false,
      timestamp: { $gte: today, $lt: tomorrow }
    });

    // Get recent login attempts
    const recentLoginAttempts = await LoginAttempt.find({
      labId: labId
    })
      .populate('userId', 'name email employeeId')
      .sort({ timestamp: -1 })
      .limit(5);

    res.json({
      totalEmployees,
      activeEmployees,
      inactiveEmployees: totalEmployees - activeEmployees,
      todayStats: {
        totalAttempts: todayLoginAttempts,
        successfulLogins: todaySuccessfulLogins,
        failedLogins: todayFailedLogins,
        geofenceViolations: todayGeofenceViolations
      },
      recentLoginAttempts
    });

  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get lab information
router.get('/lab-info', auth, async (req, res) => {
  try {
    const lab = await Lab.findById(req.user.labId).select('-adminPassword');
    res.json(lab);
  } catch (error) {
    console.error('Lab info fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
