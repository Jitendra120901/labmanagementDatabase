// Enhanced geofence function with GPS accuracy handling
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
  let distance;
  try {
    distance = geolib.getPreciseDistance ? 
      geolib.getPreciseDistance(
        { 
          latitude: parseFloat(userLocation.latitude), 
          longitude: parseFloat(userLocation.longitude) 
        },
        { 
          latitude: parseFloat(labLocation.latitude), 
          longitude: parseFloat(labLocation.longitude) 
        },
        1 // accuracy in meters (1 meter precision)
      ) :
      geolib.getDistance(
        { 
          latitude: parseFloat(userLocation.latitude), 
          longitude: parseFloat(userLocation.longitude) 
        },
        { 
          latitude: parseFloat(labLocation.latitude), 
          longitude: parseFloat(labLocation.longitude) 
        }
      );
  } catch (error) {
    // Fallback to basic distance calculation
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
  
  // GPS accuracy buffer - account for GPS inaccuracy
  const GPS_ACCURACY_BUFFER = 30; // 30 meters buffer for GPS inaccuracy
  const radiusInMeters = parseFloat(radius);
  
  // Apply GPS accuracy buffer to the radius
  const effectiveRadius = radiusInMeters + GPS_ACCURACY_BUFFER;
  
  // Calculate bearing if available
  let bearing = null;
  try {
    if (geolib.getBearing) {
      bearing = geolib.getBearing(
        { latitude: parseFloat(labLocation.latitude), longitude: parseFloat(labLocation.longitude) },
        { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) }
      );
    } else if (geolib.getGreatCircleBearing) {
      bearing = geolib.getGreatCircleBearing(
        { latitude: parseFloat(labLocation.latitude), longitude: parseFloat(labLocation.longitude) },
        { latitude: parseFloat(userLocation.latitude), longitude: parseFloat(userLocation.longitude) }
      );
    }
  } catch (error) {
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

// New function to get GPS accuracy estimate
const getGPSAccuracyEstimate = (userAgent) => {
  // Different devices have different GPS accuracy
  if (userAgent.includes('iPhone')) {
    return 5; // iPhones generally have better GPS
  } else if (userAgent.includes('Android')) {
    return 10; // Android varies more
  } else {
    return 15; // Other devices
  }
};

module.exports = { isWithinGeofence, validateLocation, formatDistance, getGPSAccuracyEstimate };