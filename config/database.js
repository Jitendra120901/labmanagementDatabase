const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect("mongodb+srv://jitendrachoudhary2729:3rsrT5kUeoNF0hzt@cluster0.0ylzypi.mongodb.net/lab_management?retryWrites=true&w=majority", {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000
    });
    
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    console.log(`Database Name: ${conn.connection.name}`);
  } catch (error) {
    console.error('Database connection error:', error);
    console.error('Error details:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;