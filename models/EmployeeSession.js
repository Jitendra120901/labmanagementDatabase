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


