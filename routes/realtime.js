// routes/realtime.js
const express = require('express');
const EmployeeSession = require('../models/EmployeeSession');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');
const { auth, requireLabAdmin } = require('../middleware/auth');
const { isWithinGeofence } = require('../utils/geofence');

const router = express.Router();

// Heartbeat endpoint - employees call this every 30 seconds
router.post('/heartbeat', auth, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');

    if (!latitude || !longitude) {
      return res.status(400).json({ message: 'Location data required' });
    }

    if (!sessionToken) {
      return res.status(401).json({ message: 'Session token required' });
    }

    const session = await EmployeeSession.findOne({
      sessionToken,
      userId: req.user.id,
      isActive: true
    }).populate('labId');

    if (!session) {
      return res.status(404).json({ message: 'No active session found' });
    }

    const location = {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude)
    };

    // Update session
    session.lastActivity = new Date();
    session.currentLocation = location;
    
    // Add heartbeat activity to session log
    session.activityLog.push({
      timestamp: new Date(),
      action: 'heartbeat',
      location: location,
      metadata: {
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      }
    });

    await session.save();

    // Check geofence for employees
    let geofenceStatus = { isWithin: true, distance: 0 };
    if (req.user.role === 'lab_employee' && session.labId) {
      geofenceStatus = isWithinGeofence(
        location,
        session.labId.location,
        session.labId.geofence.radius
      );
    }

    // Log heartbeat activity
    await new ActivityLog({
      userId: req.user.id,
      labId: req.user.labId,
      sessionId: session._id,
      action: 'heartbeat',
      location,
      distanceFromLab: geofenceStatus.distance,
      isWithinGeofence: geofenceStatus.isWithin,
      metadata: {
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        endpoint: '/api/realtime/heartbeat'
      }
    }).save();

    // Log geofence violation if outside bounds
    if (req.user.role === 'lab_employee' && !geofenceStatus.isWithin) {
      await new ActivityLog({
        userId: req.user.id,
        labId: req.user.labId,
        sessionId: session._id,
        action: 'geofence_violation',
        location,
        distanceFromLab: geofenceStatus.distance,
        isWithinGeofence: false,
        metadata: {
          violationDistance: geofenceStatus.distance,
          allowedRadius: session.labId.geofence.radius,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        }
      }).save();
    }

    res.json({
      status: 'active',
      isWithinGeofence: geofenceStatus.isWithin,
      distance: geofenceStatus.distance,
      lastActivity: session.lastActivity,
      sessionDuration: Math.round((new Date() - session.loginTime) / (1000 * 60)),
      message: geofenceStatus.isWithin ? 'Location updated' : 'Warning: Outside geofence area'
    });

  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Manual logout
router.post('/logout', auth, async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');

    if (!sessionToken) {
      return res.status(401).json({ message: 'Session token required' });
    }

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
      
      // Add logout to session activity log
      session.activityLog.push({
        timestamp: new Date(),
        action: 'logout',
        metadata: {
          sessionDuration: duration,
          logoutMethod: 'manual',
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        }
      });

      await session.save();

      // Log logout activity
      await new ActivityLog({
        userId: req.user.id,
        labId: req.user.labId,
        sessionId: session._id,
        action: 'manual_logout',
        metadata: {
          sessionDuration: duration,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          endpoint: '/api/realtime/logout'
        }
      }).save();
    }

    res.json({ 
      message: 'Logged out successfully',
      sessionDuration: session ? session.sessionDuration : 0
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get active employees (admin only)
router.get('/active-employees', auth, requireLabAdmin, async (req, res) => {
  try {
    const { timeThreshold = 5 } = req.query; // minutes
    const thresholdTime = new Date(Date.now() - timeThreshold * 60 * 1000);

    const activeSessions = await EmployeeSession.find({
      labId: req.user.labId,
      isActive: true,
      lastActivity: { $gte: thresholdTime }
    })
    .populate('userId', 'name email employeeId department designation role')
    .sort({ lastActivity: -1 });

    const activeEmployees = activeSessions.map(session => {
      const sessionDurationMinutes = Math.round((new Date() - session.loginTime) / (1000 * 60));
      const lastActivityMinutes = Math.round((new Date() - session.lastActivity) / (1000 * 60));
      
      return {
        user: session.userId,
        sessionId: session._id,
        loginTime: session.loginTime,
        lastActivity: session.lastActivity,
        currentLocation: session.currentLocation,
        sessionDuration: sessionDurationMinutes,
        isOnline: lastActivityMinutes < 2, // Online if active in last 2 minutes
        deviceInfo: session.deviceInfo,
        lastActivityMinutes
      };
    });

    // Get additional statistics
    const stats = {
      totalActive: activeEmployees.length,
      onlineCount: activeEmployees.filter(emp => emp.isOnline).length,
      averageSessionDuration: activeEmployees.length > 0 ? 
        Math.round(activeEmployees.reduce((sum, emp) => sum + emp.sessionDuration, 0) / activeEmployees.length) : 0,
      longestSession: activeEmployees.length > 0 ? 
        Math.max(...activeEmployees.map(emp => emp.sessionDuration)) : 0
    };

    res.json({
      activeEmployees,
      stats,
      lastUpdated: new Date()
    });

  } catch (error) {
    console.error('Active employees error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get employee activity timeline (admin only)
router.get('/employee-activity/:userId', auth, requireLabAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { date, limit = 50, action } = req.query;

    // Verify the employee belongs to the same lab
    const employee = await User.findOne({
      _id: userId,
      labId: req.user.labId
    });

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    let dateFilter = {};
    if (date) {
      const targetDate = new Date(date);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);
      dateFilter = {
        timestamp: {
          $gte: targetDate,
          $lt: nextDay
        }
      };
    } else {
      // Default to today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      dateFilter = {
        timestamp: {
          $gte: today,
          $lt: tomorrow
        }
      };
    }

    let actionFilter = {};
    if (action) {
      actionFilter = { action };
    }

    const activities = await ActivityLog.find({
      userId,
      labId: req.user.labId,
      ...dateFilter,
      ...actionFilter
    })
    .populate('userId', 'name email employeeId')
    .populate('sessionId', 'loginTime deviceInfo')
    .sort({ timestamp: -1 })
    .limit(parseInt(limit));

    // Group activities by session for better visualization
    const sessionsMap = new Map();
    activities.forEach(activity => {
      const sessionId = activity.sessionId?._id?.toString();
      if (sessionId) {
        if (!sessionsMap.has(sessionId)) {
          sessionsMap.set(sessionId, {
            sessionId: activity.sessionId._id,
            loginTime: activity.sessionId.loginTime,
            deviceInfo: activity.sessionId.deviceInfo,
            activities: []
          });
        }
        sessionsMap.get(sessionId).activities.push(activity);
      }
    });

    res.json({
      employee: {
        id: employee._id,
        name: employee.name,
        email: employee.email,
        employeeId: employee.employeeId,
        department: employee.department,
        designation: employee.designation
      },
      activities,
      sessionGroups: Array.from(sessionsMap.values()),
      totalActivities: activities.length,
      dateRange: date || 'today'
    });

  } catch (error) {
    console.error('Employee activity error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get session statistics (admin only)
router.get('/session-stats', auth, requireLabAdmin, async (req, res) => {
  try {
    const { startDate, endDate, employeeId } = req.query;
    
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = {
        loginTime: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      };
    } else {
      // Default to last 7 days
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = {
        loginTime: { $gte: weekAgo }
      };
    }

    let employeeFilter = {};
    if (employeeId) {
      employeeFilter = { userId: employeeId };
    }

    const sessions = await EmployeeSession.find({
      labId: req.user.labId,
      ...dateFilter,
      ...employeeFilter
    }).populate('userId', 'name email employeeId department designation');

    // Calculate comprehensive statistics
    const stats = {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.isActive).length,
      completedSessions: sessions.filter(s => !s.isActive).length,
      averageSessionDuration: 0,
      totalWorkHours: 0,
      longestSession: 0,
      shortestSession: Infinity,
      employeeStats: {},
      dailyStats: {},
      hourlyDistribution: Array(24).fill(0),
      departmentStats: {},
      deviceStats: {}
    };

    let totalDuration = 0;
    let completedSessionsCount = 0;

    sessions.forEach(session => {
      const duration = session.sessionDuration || 
        (session.isActive ? Math.round((new Date() - session.loginTime) / (1000 * 60)) : 0);
      
      if (!session.isActive && duration > 0) {
        totalDuration += duration;
        completedSessionsCount++;
        
        if (duration > stats.longestSession) stats.longestSession = duration;
        if (duration < stats.shortestSession) stats.shortestSession = duration;
      }

      stats.totalWorkHours += duration;

      // Employee stats
      const empId = session.userId._id.toString();
      if (!stats.employeeStats[empId]) {
        stats.employeeStats[empId] = {
          employee: session.userId,
          totalSessions: 0,
          totalMinutes: 0,
          averageDuration: 0,
          activeSessions: 0,
          longestSession: 0
        };
      }
      stats.employeeStats[empId].totalSessions++;
      stats.employeeStats[empId].totalMinutes += duration;
      if (session.isActive) stats.employeeStats[empId].activeSessions++;
      if (duration > stats.employeeStats[empId].longestSession) {
        stats.employeeStats[empId].longestSession = duration;
      }

      // Daily stats
      const dateKey = session.loginTime.toISOString().split('T')[0];
      if (!stats.dailyStats[dateKey]) {
        stats.dailyStats[dateKey] = {
          date: dateKey,
          sessions: 0,
          totalMinutes: 0,
          uniqueEmployees: new Set(),
          averageDuration: 0
        };
      }
      stats.dailyStats[dateKey].sessions++;
      stats.dailyStats[dateKey].totalMinutes += duration;
      stats.dailyStats[dateKey].uniqueEmployees.add(empId);

      // Hourly distribution
      const hour = session.loginTime.getHours();
      stats.hourlyDistribution[hour]++;

      // Department stats
      const dept = session.userId.department || 'Unknown';
      if (!stats.departmentStats[dept]) {
        stats.departmentStats[dept] = {
          department: dept,
          sessions: 0,
          totalMinutes: 0,
          employees: new Set()
        };
      }
      stats.departmentStats[dept].sessions++;
      stats.departmentStats[dept].totalMinutes += duration;
      stats.departmentStats[dept].employees.add(empId);

      // Device stats
      const device = session.deviceInfo?.os || 'Unknown';
      if (!stats.deviceStats[device]) {
        stats.deviceStats[device] = { count: 0, totalMinutes: 0 };
      }
      stats.deviceStats[device].count++;
      stats.deviceStats[device].totalMinutes += duration;
    });

    // Calculate averages
    if (completedSessionsCount > 0) {
      stats.averageSessionDuration = Math.round(totalDuration / completedSessionsCount);
    }

    if (stats.shortestSession === Infinity) stats.shortestSession = 0;

    // Convert employee stats object to array and calculate averages
    stats.employeeStats = Object.values(stats.employeeStats).map(emp => ({
      ...emp,
      averageDuration: emp.totalSessions > 0 ? Math.round(emp.totalMinutes / emp.totalSessions) : 0
    }));

    // Convert daily stats and calculate averages
    stats.dailyStats = Object.values(stats.dailyStats).map(day => ({
      ...day,
      uniqueEmployees: day.uniqueEmployees.size,
      averageDuration: day.sessions > 0 ? Math.round(day.totalMinutes / day.sessions) : 0
    }));

    // Convert department stats
    stats.departmentStats = Object.values(stats.departmentStats).map(dept => ({
      ...dept,
      employees: dept.employees.size,
      averageDuration: dept.sessions > 0 ? Math.round(dept.totalMinutes / dept.sessions) : 0
    }));

    res.json({
      stats,
      period: {
        start: startDate || 'Last 7 days',
        end: endDate || 'Now',
        employeeFilter: employeeId || 'All employees'
      },
      lastUpdated: new Date()
    });

  } catch (error) {
    console.error('Session stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get real-time dashboard summary (admin only)
router.get('/dashboard-summary', auth, requireLabAdmin, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Get active sessions (last 5 minutes)
    const activeThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const activeSessions = await EmployeeSession.countDocuments({
      labId: req.user.labId,
      isActive: true,
      lastActivity: { $gte: activeThreshold }
    });

    // Get online employees (last 2 minutes)
    const onlineThreshold = new Date(now.getTime() - 2 * 60 * 1000);
    const onlineEmployees = await EmployeeSession.countDocuments({
      labId: req.user.labId,
      isActive: true,
      lastActivity: { $gte: onlineThreshold }
    });

    // Today's sessions
    const todaysSessions = await EmployeeSession.countDocuments({
      labId: req.user.labId,
      loginTime: { $gte: today }
    });

    // Today's total work hours
    const todaysCompletedSessions = await EmployeeSession.find({
      labId: req.user.labId,
      loginTime: { $gte: today },
      isActive: false
    });

    const todaysWorkMinutes = todaysCompletedSessions.reduce((total, session) => 
      total + (session.sessionDuration || 0), 0);

    // Recent geofence violations (last 24 hours)
    const recentViolations = await ActivityLog.countDocuments({
      labId: req.user.labId,
      action: 'geofence_violation',
      timestamp: { $gte: yesterday }
    });

    // Average session duration (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekSessions = await EmployeeSession.find({
      labId: req.user.labId,
      loginTime: { $gte: weekAgo },
      isActive: false,
      sessionDuration: { $gt: 0 }
    });

    const avgSessionDuration = weekSessions.length > 0 ? 
      Math.round(weekSessions.reduce((sum, s) => sum + s.sessionDuration, 0) / weekSessions.length) : 0;

    res.json({
      realTime: {
        activeEmployees: activeSessions,
        onlineEmployees: onlineEmployees,
        timestamp: now
      },
      today: {
        totalSessions: todaysSessions,
        totalWorkHours: Math.round(todaysWorkMinutes / 60 * 10) / 10,
        averageSessionLength: todaysCompletedSessions.length > 0 ? 
          Math.round(todaysWorkMinutes / todaysCompletedSessions.length) : 0
      },
      recent: {
        geofenceViolations: recentViolations,
        averageSessionDuration: avgSessionDuration
      },
      thresholds: {
        activeThreshold: 5, // minutes
        onlineThreshold: 2  // minutes
      }
    });

  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update location manually (for testing or manual updates)
router.post('/update-location', auth, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');

    if (!latitude || !longitude) {
      return res.status(400).json({ message: 'Latitude and longitude required' });
    }

    const session = await EmployeeSession.findOne({
      sessionToken,
      userId: req.user.id,
      isActive: true
    }).populate('labId');

    if (!session) {
      return res.status(404).json({ message: 'No active session found' });
    }

    const location = {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude)
    };

    // Update session location
    session.currentLocation = location;
    session.lastActivity = new Date();
    await session.save();

    // Check geofence
    let geofenceStatus = { isWithin: true, distance: 0 };
    if (req.user.role === 'lab_employee' && session.labId) {
      geofenceStatus = isWithinGeofence(
        location,
        session.labId.location,
        session.labId.geofence.radius
      );
    }

    // Log location update
    await new ActivityLog({
      userId: req.user.id,
      labId: req.user.labId,
      sessionId: session._id,
      action: 'location_update',
      location,
      distanceFromLab: geofenceStatus.distance,
      isWithinGeofence: geofenceStatus.isWithin,
      metadata: {
        updateMethod: 'manual',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      }
    }).save();

    res.json({
      message: 'Location updated successfully',
      location,
      geofenceStatus,
      lastActivity: session.lastActivity
    });

  } catch (error) {
    console.error('Location update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;