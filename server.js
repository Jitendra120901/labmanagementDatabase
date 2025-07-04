const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/database');

// Load environment variables
dotenv.config();

// Connect to database
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy for accurate IP addresses
app.set('trust proxy', true);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

app.get('/', (req, res) => {
    res.json({
      message: 'Lab Management System API',
      version: '1.0.0',
      status: 'Running',
      endpoints: {
        health: '/api/health',
        auth: {
          register: 'POST /api/auth/register-lab',
          login: 'POST /api/auth/login',
          profile: 'GET /api/auth/profile'
        },
        users: {
          createEmployee: 'POST /api/users/create-employee',
          listEmployees: 'GET /api/users/employees',
          loginAttempts: 'GET /api/users/login-attempts'
        },
        dashboard: {
          stats: 'GET /api/dashboard/stats',
          labInfo: 'GET /api/dashboard/lab-info'
        }
      },
      documentation: 'Visit /api/health for server status'
    });
  });
// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

const PORT = 4000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

module.exports = app;