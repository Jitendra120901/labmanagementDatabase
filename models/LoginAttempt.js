// models/LoginAttempt.js
const mongoose = require('mongoose');

const loginAttemptSchema = new mongoose.Schema({
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
  attemptLocation: {
    latitude: {
      type: Number,
      required: true
    },
    longitude: {
      type: Number,
      required: true
    }
  },
  isSuccessful: {
    type: Boolean,
    required: true
  },
  isWithinGeofence: {
    type: Boolean,
    required: true
  },
  distanceFromLab: {
    type: Number, // in meters
    required: true
  },
  ipAddress: {
    type: String,
    required: true
  },
  userAgent: {
    type: String,
    required: true
  },
  failureReason: {
    type: String,
    enum: ['invalid_credentials', 'outside_geofence', 'account_inactive'],
    default: undefined // Allow undefined for successful logins
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema);