const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Lab = require('../models/Lab');
const LoginAttempt = require('../models/LoginAttempt');
const { auth, requireLabAdmin } = require('../middleware/auth');

const router = express.Router();

// Create lab employee (only lab admin can do this)
router.post('/create-employee', [
  auth,
  requireLabAdmin,
  body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('phone').trim().matches(/^\+?[\d\s-()]+$/).withMessage('Invalid phone number'),
  body('employeeId').trim().isLength({ min: 3 }).withMessage('Employee ID required'),
  body('department').trim().isLength({ min: 2 }).withMessage('Department required'),
  body('designation').trim().isLength({ min: 2 }).withMessage('Designation required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, phone, employeeId, department, designation } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: email },
        { employeeId: employeeId }
      ]
    });

    if (existingUser) {
      return res.status(400).json({ message: 'User with this email or employee ID already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create employee
    const employee = new User({
      name,
      email,
      password: hashedPassword,
      phone,
      employeeId,
      role: 'lab_employee',
      labId: req.user.labId,
      department,
      designation
    });

    await employee.save();

    // Return employee data without password
    const employeeData = await User.findById(employee._id)
      .populate('labId', 'name')
      .select('-password');

    res.status(201).json({
      message: 'Employee created successfully',
      employee: employeeData
    });

  } catch (error) {
    console.error('Employee creation error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all lab employees (only lab admin can do this)
router.get('/employees', auth, requireLabAdmin, async (req, res) => {
  try {
    const employees = await User.find({
      labId: req.user.labId,
      role: 'lab_employee'
    }).select('-password').sort({ createdAt: -1 });

    res.json(employees);
  } catch (error) {
    console.error('Employees fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get employee by ID (only lab admin can do this)
router.get('/employees/:id', auth, requireLabAdmin, async (req, res) => {
  try {
    const employee = await User.findOne({
      _id: req.params.id,
      labId: req.user.labId,
      role: 'lab_employee'
    }).select('-password');

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.json(employee);
  } catch (error) {
    console.error('Employee fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update employee (only lab admin can do this)
router.put('/employees/:id', [
  auth,
  requireLabAdmin,
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Invalid email'),
  body('phone').optional().trim().matches(/^\+?[\d\s-()]+$/).withMessage('Invalid phone number'),
  body('department').optional().trim().isLength({ min: 2 }).withMessage('Department required'),
  body('designation').optional().trim().isLength({ min: 2 }).withMessage('Designation required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, phone, department, designation, isActive } = req.body;

    const employee = await User.findOne({
      _id: req.params.id,
      labId: req.user.labId,
      role: 'lab_employee'
    });

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Update fields
    if (name) employee.name = name;
    if (email) employee.email = email;
    if (phone) employee.phone = phone;
    if (department) employee.department = department;
    if (designation) employee.designation = designation;
    if (typeof isActive === 'boolean') employee.isActive = isActive;

    await employee.save();

    const updatedEmployee = await User.findById(employee._id).select('-password');
    res.json(updatedEmployee);

  } catch (error) {
    console.error('Employee update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete employee (only lab admin can do this)
router.delete('/employees/:id', auth, requireLabAdmin, async (req, res) => {
  try {
    const employee = await User.findOne({
      _id: req.params.id,
      labId: req.user.labId,
      role: 'lab_employee'
    });

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Employee deleted successfully' });

  } catch (error) {
    console.error('Employee deletion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get login attempts for lab (only lab admin can do this)
router.get('/login-attempts', auth, requireLabAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, userId } = req.query;
    const query = { labId: req.user.labId };
    
    if (userId) {
      query.userId = userId;
    }

    const loginAttempts = await LoginAttempt.find(query)
      .populate('userId', 'name email employeeId')
      .sort({ timestamp: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await LoginAttempt.countDocuments(query);

    res.json({
      loginAttempts,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });

  } catch (error) {
    console.error('Login attempts fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
