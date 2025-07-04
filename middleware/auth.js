const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Authentication middleware
 * Verifies JWT token and adds user info to request object
 */
const auth = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return res.status(401).json({ message: 'No token provided, authorization denied' });
    }

    // Extract token (remove 'Bearer ' prefix)
    const token = authHeader.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided, authorization denied' });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const user = await User.findById(decoded.id)
      .populate('labId', 'name address location geofence')
      .select('-password');
    
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Token is not valid - user not found or inactive' });
    }

    // Add user info to request object
    req.user = {
      id: user._id.toString(),
      role: user.role,
      labId: user.labId._id.toString(),
      email: user.email,
      name: user.name,
      employeeId: user.employeeId,
      department: user.department,
      designation: user.designation
    };
    
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token has expired' });
    }
    
    res.status(401).json({ message: 'Token verification failed' });
  }
};

/**
 * Lab admin authorization middleware
 * Ensures user has lab_admin role
 */
const requireLabAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  if (req.user.role !== 'lab_admin') {
    return res.status(403).json({ 
      message: 'Access denied. Lab administrator role required.',
      userRole: req.user.role 
    });
  }
  
  next();
};

/**
 * Lab employee authorization middleware
 * Ensures user has lab_employee role
 */
const requireLabEmployee = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  if (req.user.role !== 'lab_employee') {
    return res.status(403).json({ 
      message: 'Access denied. Lab employee role required.',
      userRole: req.user.role 
    });
  }
  
  next();
};

/**
 * Flexible role authorization middleware
 * Accepts array of allowed roles
 */
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: 'Access denied. Insufficient permissions.',
        userRole: req.user.role,
        allowedRoles: allowedRoles
      });
    }
    
    next();
  };
};

/**
 * Optional authentication middleware
 * Adds user info if token is present, but doesn't require it
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return next(); // No token, continue without user info
    }

    const token = authHeader.replace('Bearer ', '');
    
    if (!token) {
      return next(); // No token, continue without user info
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id)
      .populate('labId', 'name address location geofence')
      .select('-password');
    
    if (user && user.isActive) {
      req.user = {
        id: user._id.toString(),
        role: user.role,
        labId: user.labId._id.toString(),
        email: user.email,
        name: user.name,
        employeeId: user.employeeId,
        department: user.department,
        designation: user.designation
      };
    }
    
    next();
  } catch (error) {
    // Token verification failed, but we continue without user info
    next();
  }
};

module.exports = {
  auth,
  requireLabAdmin,
  requireLabEmployee,
  requireRole,
  optionalAuth
};