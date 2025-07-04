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
  
  // Calculate accurate distance using Haversine formula with high precision
  const distance = geolib.getPreciseDistance(
    { 
      latitude: parseFloat(userLocation.latitude), 
      longitude: parseFloat(userLocation.longitude) 
    },
    { 
      latitude: parseFloat(labLocation.latitude), 
      longitude: parseFloat(labLocation.longitude) 
    },
    1 // accuracy in meters (1 meter precision)
  );
  
  // Convert radius from meters to meters (assuming radius is in meters)
  // If radius is in different unit, convert accordingly
  const radiusInMeters = parseFloat(radius);
  
  return {
    isWithin: distance <= radiusInMeters,
    distance: distance, // distance in meters
    distanceInKm: Math.round((distance / 1000) * 100) / 100, // rounded to 2 decimal places
    radiusInMeters: radiusInMeters,
    bearing: geolib.getBearing(
      { latitude: parseFloat(labLocation.latitude), longitude: parseFloat(labLocation.longitude) },
      { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) }
    )
  };
};

const validateLocation = (latitude, longitude) => {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    !isNaN(latitude) &&
    !isNaN(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude !== 0 && longitude !== 0 // Avoid default/null coordinates
  );
};

// Additional utility function for distance formatting
const formatDistance = (distanceInMeters) => {
  if (distanceInMeters < 1000) {
    return `${Math.round(distanceInMeters)} meters`;
  } else {
    return `${Math.round((distanceInMeters / 1000) * 100) / 100} km`;
  }
};

module.exports = { isWithinGeofence, validateLocation, formatDistance };