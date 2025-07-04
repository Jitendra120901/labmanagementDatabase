// utils/geofence.js - Fixed version with proper geolib import
const geolib = require('geolib');

const isWithinGeofence = (userLocation, labLocation, radius = 20) => {
  // Validate input coordinates
  if (!userLocation || !labLocation) {
    throw new Error('Invalid location data provided');
  }
  
  if (!validateLocation(userLocation.latitude, userLocation.longitude)) {
    throw new Error('Invalid user location coordinates');
  }
  
  if (!validateLocation(labLocation.latitude, labLocation.longitude)) {
    throw new Error('Invalid lab location coordinates');
  }
  
  // Calculate distance using geolib
  let distance;
  try {
    // Try precise distance first, fallback to regular distance
    if (typeof geolib.getPreciseDistance === 'function') {
      distance = geolib.getPreciseDistance(
        { 
          latitude: parseFloat(userLocation.latitude), 
          longitude: parseFloat(userLocation.longitude) 
        },
        { 
          latitude: parseFloat(labLocation.latitude), 
          longitude: parseFloat(labLocation.longitude) 
        },
        1 // accuracy in meters
      );
    } else {
      // Fallback to regular getDistance
      distance = geolib.getDistance(
        { 
          latitude: parseFloat(userLocation.latitude), 
          longitude: parseFloat(userLocation.longitude) 
        },
        { 
          latitude: parseFloat(labLocation.latitude), 
          longitude: parseFloat(labLocation.longitude) 
        }
      );
    }
  } catch (error) {
    console.error('Geolib distance calculation error:', error);
    // Manual Haversine formula as ultimate fallback
    distance = calculateHaversineDistance(
      parseFloat(userLocation.latitude), 
      parseFloat(userLocation.longitude),
      parseFloat(labLocation.latitude), 
      parseFloat(labLocation.longitude)
    );
  }
  
  // GPS accuracy buffer - account for GPS inaccuracy
  const GPS_ACCURACY_BUFFER = 30; // 30 meters buffer for GPS inaccuracy
  const radiusInMeters = parseFloat(radius);
  
  // Apply GPS accuracy buffer to the radius
  const effectiveRadius = radiusInMeters + GPS_ACCURACY_BUFFER;
  
  // Calculate bearing if available
  let bearing = null;
  try {
    if (typeof geolib.getBearing === 'function') {
      bearing = geolib.getBearing(
        { latitude: parseFloat(labLocation.latitude), longitude: parseFloat(labLocation.longitude) },
        { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) }
      );
    } else if (typeof geolib.getGreatCircleBearing === 'function') {
      bearing = geolib.getGreatCircleBearing(
        { latitude: parseFloat(labLocation.latitude), longitude: parseFloat(labLocation.longitude) },
        { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) }
      );
    }
  } catch (error) {
    console.error('Bearing calculation error:', error);
    bearing = null;
  }
  
  return {
    isWithin: distance <= effectiveRadius, // Use effective radius with GPS buffer
    distance: distance, // actual distance in meters
    distanceInKm: Math.round((distance / 1000) * 100) / 100,
    radiusInMeters: radiusInMeters, // original radius
    effectiveRadius: effectiveRadius, // radius + GPS buffer
    gpsAccuracyBuffer: GPS_ACCURACY_BUFFER,
    bearing: bearing,
    // Additional info for debugging
    isWithinOriginalRadius: distance <= radiusInMeters,
    isWithinGPSBuffer: distance <= effectiveRadius && distance > radiusInMeters
  };
};

// Manual Haversine distance calculation as fallback
const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  const distance = R * c; // in metres
  return Math.round(distance);
};

// Enhanced validation that's more lenient
const validateLocation = (latitude, longitude) => {
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  
  return (
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
};

// Enhanced distance formatting
const formatDistance = (distanceInMeters) => {
  if (distanceInMeters < 1000) {
    return `${Math.round(distanceInMeters)} meters`;
  } else {
    return `${Math.round((distanceInMeters / 1000) * 100) / 100} km`;
  }
};

// Get GPS accuracy estimate
const getGPSAccuracyEstimate = (userAgent) => {
  if (!userAgent) return 15;
  
  if (userAgent.includes('iPhone')) {
    return 5; // iPhones generally have better GPS
  } else if (userAgent.includes('Android')) {
    return 10; // Android varies more
  } else {
    return 15; // Other devices
  }
};

module.exports = { 
  isWithinGeofence, 
  validateLocation, 
  formatDistance, 
  getGPSAccuracyEstimate,
  calculateHaversineDistance 
};