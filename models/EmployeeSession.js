// models/EmployeeSession.js
const mongoose = require('mongoose');

const employeeSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  labId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lab',
    required: true
  },
  sessionToken: {
    type: String,
    required: true,
    index: true
  },
  loginTime: {
    type: Date,
    default: Date.now,
    required: true
  },
  lastActivity: {
    type: Date,
    default: Date.now,
    required: true
  },
  currentLocation: {
    latitude: {
      type: Number,
      required: true
    },
    longitude: {
      type: Number,
      required: true
    }
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  logoutTime: {
    type: Date
  },
  sessionDuration: {
    type: Number, // in minutes
    default: 0
  },
  deviceInfo: {
    userAgent: String,
    ipAddress: String,
    browser: String,
    os: String
  },
  activityLog: [{
    timestamp: {
      type: Date,
      default: Date.now
    },
    action: {
      type: String,
      enum: ['login', 'heartbeat', 'logout', 'timeout', 'location_update'],
      required: true
    },
    location: {
      latitude: Number,
      longitude: Number
    },
    metadata: mongoose.Schema.Types.Mixed
  }]
}, {
  timestamps: true
});

// Indexes for better performance
employeeSessionSchema.index({ userId: 1, isActive: 1 });
employeeSessionSchema.index({ labId: 1, isActive: 1 });
employeeSessionSchema.index({ sessionToken: 1 });
employeeSessionSchema.index({ lastActivity: 1 });
employeeSessionSchema.index({ loginTime: -1 });

// Pre-save middleware to calculate session duration
employeeSessionSchema.pre('save', function(next) {
  if (this.logoutTime && this.loginTime) {
    this.sessionDuration = Math.round((this.logoutTime - this.loginTime) / (1000 * 60));
  }
  next();
});

// Instance method to add activity
employeeSessionSchema.methods.addActivity = function(action, location = null, metadata = {}) {
  this.activityLog.push({
    timestamp: new Date(),
    action,
    location,
    metadata
  });
  this.lastActivity = new Date();
  return this.save();
};

// Static method to get active sessions for a lab
employeeSessionSchema.statics.getActiveSessions = function(labId, timeThreshold = 5) {
  const thresholdTime = new Date(Date.now() - timeThreshold * 60 * 1000);
  return this.find({
    labId,
    isActive: true,
    lastActivity: { $gte: thresholdTime }
  }).populate('userId', 'name email employeeId department designation');
};

module.exports = mongoose.model('EmployeeSession', employeeSessionSchema);

// models/ActivityLog.js
const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  labId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lab',
    required: true,
    index: true
  },
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmployeeSession',
    required: true,
    index: true
  },
  action: {
    type: String,
    enum: [
      'login', 
      'logout', 
      'heartbeat', 
      'location_update', 
      'dashboard_access',
      'api_call',
      'timeout',
      'manual_logout',
      'geofence_violation',
      'session_start',
      'session_end'
    ],
    required: true,
    index: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  location: {
    latitude: {
      type: Number
    },
    longitude: {
      type: Number
    }
  },
  distanceFromLab: {
    type: Number, // in meters
    default: 0
  },
  isWithinGeofence: {
    type: Boolean,
    default: true,
    index: true
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    endpoint: String,
    responseTime: Number,
    statusCode: Number,
    errorMessage: String,
    sessionDuration: Number,
    loginMethod: String,
    logoutMethod: String,
    browser: String,
    os: String,
    deviceType: String
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
activityLogSchema.index({ userId: 1, timestamp: -1 });
activityLogSchema.index({ labId: 1, timestamp: -1 });
activityLogSchema.index({ sessionId: 1, timestamp: -1 });
activityLogSchema.index({ action: 1, timestamp: -1 });
activityLogSchema.index({ isWithinGeofence: 1, timestamp: -1 });

// Static method to get activity summary for a date range
activityLogSchema.statics.getActivitySummary = async function(labId, startDate, endDate) {
  const pipeline = [
    {
      $match: {
        labId: mongoose.Types.ObjectId(labId),
        timestamp: {
          $gte: startDate,
          $lte: endDate
        }
      }
    },
    {
      $group: {
        _id: {
          userId: '$userId',
          action: '$action'
        },
        count: { $sum: 1 },
        lastActivity: { $max: '$timestamp' }
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id.userId',
        foreignField: '_id',
        as: 'user'
      }
    },
    {
      $unwind: '$user'
    },
    {
      $group: {
        _id: '$_id.userId',
        user: { $first: '$user' },
        activities: {
          $push: {
            action: '$_id.action',
            count: '$count',
            lastActivity: '$lastActivity'
          }
        },
        totalActivities: { $sum: '$count' }
      }
    }
  ];

  return this.aggregate(pipeline);
};

module.exports = mongoose.model('ActivityLog', activityLogSchema);