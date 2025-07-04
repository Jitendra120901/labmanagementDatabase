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