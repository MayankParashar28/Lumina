const jwt = require("jsonwebtoken");
require("dotenv").config(); // Load environment variables

const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error("❌ JWT_SECRET is not defined in .env. Please add it to secure your application.");
}
const expiresIn = "7d"; // Token expiration

// Function to create a JWT token for a user
function createTokenForUser(user) {
  try {
    const payload = {
      _id: user._id,
      email: user.email,
      profileImageUrl: user.profileImageUrl || "/default-profile.png", // Default profile image
      role: user.role || "user",
    };

    return jwt.sign(payload, secret, { expiresIn });
  } catch (error) {
    console.error("❌ Error creating token:", error);
    return null;
  }
}

// Function to validate a JWT token
function validateToken(token) {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    console.error("❌ Invalid or expired token:", error.message);
    return null;
  }
}

module.exports = {
  createTokenForUser,
  validateToken,
};