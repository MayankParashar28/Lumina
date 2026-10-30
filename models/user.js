const mongoose = require("mongoose");
const { createTokenForUser } = require("../services/authentication");
const { hashPassword, verifyPassword, isLegacyHash } = require("../services/password");

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
      minlength: 8,
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
userSchema.pre("save", async function () {
  // Allow skipping hash (useful when moving from pendingUser which is already hashed)
  if (this._skipHash) return;

  if (!this.isModified("password")) return;

  const { salt, hash } = await hashPassword(this.password);
  this.salt = salt;
  this.password = hash;
});

// ✅ Function to validate password and generate token
userSchema.statics.matchPasswordAndGenerateToken = async function (email, password) {
  // 🔐 Explicitly select password and salt because they are hidden by default
  const user = await this.findOne({ email }).select("+password +salt");

  if (!user) {
    throw new Error("User not found");
  }

  // Constant-time comparison happens inside verifyPassword.
  const ok = await verifyPassword(password, user.password, user.salt);
  if (!ok) {
    throw new Error("Incorrect password");
  }

  // 🔁 Transparent migration: an account still on the old single-round HMAC hash
  // gets upgraded to scrypt now that we have the plaintext in hand. Done after
  // the password is confirmed, and failures here must not block the login.
  if (isLegacyHash(user.password)) {
    try {
      const { salt, hash } = await hashPassword(password);
      await this.updateOne({ _id: user._id }, { $set: { password: hash, salt } });
    } catch (_) {
      // Keep the legacy hash; the next successful login will try again.
    }
  }

  return createTokenForUser(user);
};


// Prevents overwriting the model if already compiled
const User = mongoose.models.user || mongoose.model("user", userSchema);

module.exports = User;