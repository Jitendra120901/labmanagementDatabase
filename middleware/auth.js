const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Lab = require('../models/Lab');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).populate('labId');
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

const requireLabAdmin = (req, res, next) => {
  if (req.user.role !== 'lab_admin') {
    return res.status(403).json({ message: 'Access denied. Lab admin required.' });
  }
  next();
};

module.exports = { auth, requireLabAdmin };