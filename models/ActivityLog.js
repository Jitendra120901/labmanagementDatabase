const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
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
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmployeeSession',
    required: true
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
      'geofence_violation'
    ],
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  location: {
    latitude: Number,
    longitude: Number
  },
  distanceFromLab: {
    type: Number, // in meters
    default: 0
  },
  isWithinGeofence: {
    type: Boolean,
    default: true
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    endpoint: String,
    responseTime: Number,
    statusCode: Number,
    errorMessage: String
  }
});

// Indexes
activityLogSchema.index({ userId: 1, timestamp: -1 });
activityLogSchema.index({ labId: 1, timestamp: -1 });
activityLogSchema.index({ sessionId: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);