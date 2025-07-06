// utils/geofence.js - Simplified for basic lat/lng only
const geolib = require('geolib');

const isWithinGeofence = (userLocation, labLocation, radius = 100) => {
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
    // Manual Haversine formula as fallback
    distance = calculateHaversineDistance(
      parseFloat(userLocation.latitude), 
      parseFloat(userLocation.longitude),
      parseFloat(labLocation.latitude), 
      parseFloat(labLocation.longitude)
    );
  }
  
  const radiusInMeters = parseFloat(radius);
  
  // Simple comparison - no GPS buffers or accuracy calculations
  const isWithin = distance <= radiusInMeters;
  
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
    isWithin: isWithin,
    distance: distance, // actual distance in meters
    distanceInKm: Math.round((distance / 1000) * 100) / 100,
    radiusInMeters: radiusInMeters,
    bearing: bearing
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

// Basic validation
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

// Simple distance formatting
const formatDistance = (distanceInMeters) => {
  if (distanceInMeters < 1000) {
    return `${Math.round(distanceInMeters)} meters`;
  } else {
    return `${Math.round((distanceInMeters / 1000) * 100) / 100} km`;
  }
};

module.exports = { 
  isWithinGeofence, 
  validateLocation, 
  formatDistance,
  calculateHaversineDistance
};