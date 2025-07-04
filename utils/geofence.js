const geolib = require('geolib');

const isWithinGeofence = (userLocation, labLocation, radius = 20) => {
  const distance = geolib.getDistance(
    { latitude: userLocation.latitude, longitude: userLocation.longitude },
    { latitude: labLocation.latitude, longitude: labLocation.longitude }
  );
  
  return {
    isWithin: distance <= radius,
    distance: distance
  };
};

const validateLocation = (latitude, longitude) => {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
};

module.exports = { isWithinGeofence, validateLocation };