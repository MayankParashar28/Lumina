const { createHmac, randomBytes } = require("crypto");
const mongoose = require("mongoose");
const { createTokenForUser } = require("../services/authentication");
const Blog = require("./blog");

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    fullName: {
      type: String,
      required: true,  // Keeping "require" as it is
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    salt: {
      type: String,
      select: false, // 🛡️ Security: Hide by default
    },
    password: {
      type: String,
      required: true,
      select: false, // 🛡️ Security: Hide by default
    },

    bio: {
      type: String,
      default: "",
    },
    // 💼 Professional Details

    website: {
      type: String,
      default: "",
    },

    // 🔔 Notification Preferences
    notificationPreferences: {
      emailOnComment: { type: Boolean, default: true },
      emailOnFollow: { type: Boolean, default: true },
    },



    // 🚫 Account Status (Moderation)
    status: {
      type: String,
      enum: ["active", "banned", "suspended"],
      default: "active",
    },
    // ... (lines 31-81 unchanged)
    stripeCustomerId: {
      type: String,
      select: false,
    },
    subscriptionId: {
      type: String,
      select: false,
    },
    lastProfileEdit: {
      type: Date,
    },
    profilePic: {
      type: String,
      default: "/images/default-avatar.png",
    },
    socials: {
      linkedin: { type: String, default: "" },
      twitter: { type: String, default: "" },
      github: { type: String, default: "" },
      instagram: { type: String, default: "" },
    },
    followers: [
      {
        type: Schema.Types.ObjectId,
        ref: "user",
      },
    ],
    following: [
      {
        type: Schema.Types.ObjectId,
        ref: "user",
      },
    ],
    bookmarks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "blog"
      }
    ],

    role: {
      type: String,
      enum: ["USER", "ADMIN"],
      default: "USER",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    verificationToken: {
      type: String,
      select: false,
    },
    verificationTokenExpires: {
      type: Date,
      select: false,
    },
    resetPasswordToken: {
      type: String,
      select: false,
    },
    resetPasswordExpires: {
      type: Date,
      select: false,
    },
    lastAiRequest: {
      type: Date, // Tracks when the user last used an AI feature
    },
    readingHistory: [{
      blogId: { type: Schema.Types.ObjectId, ref: 'blog' },
      viewedAt: { type: Date, default: Date.now }
    }]
  },
  { timestamps: true }
);

// ✅ Hash password before saving user
userSchema.pre("save", function (next) {
  // Allow skipping hash (useful when moving from pendingUser which is already hashed)
  if (this._skipHash) return next();

  if (!this.isModified("password")) return next();

  const salt = randomBytes(16).toString("hex");
  this.salt = salt;
  this.password = createHmac("sha256", salt)
    .update(this.password)
    .digest("hex");

  next();
});

// ✅ Function to validate password and generate token
userSchema.statics.matchPasswordAndGenerateToken = async function (email, password) {
  // console.log("🔍 Received email:", email);
  // console.log("🔍 Received password:", password);

  // 🔐 Explicitly select password and salt because they are hidden by default
  const user = await this.findOne({ email }).select("+password +salt");

  if (!user) {
    // console.log("❌ User not found");
    throw new Error("User not found");
  }

  // console.log("🟢 User found:", user.email);

  const salt = user.salt;
  const hashedPassword = user.password;

  // console.log("🔍 User's hashed password from DB:", hashedPassword);
  // console.log("🔍 User's salt:", salt);

  const userProvideHashed = createHmac("sha256", salt)
    .update(password)
    .digest("hex");

  // console.log("🔍 Hashed password from user input:", userProvideHashed);

  if (hashedPassword !== userProvideHashed) {
    // console.log("❌ Passwords do not match");
    throw new Error("Incorrect password");
  }

  // console.log("🟢 Passwords match! Generating token...");

  const token = createTokenForUser(user);
  // console.log("🟢 Token generated:", token);

  return token;
};


// Prevents overwriting the model if already compiled
const User = mongoose.models.user || mongoose.model("user", userSchema);

module.exports = User;