const { Router } = require("express");
const mongoose = require("mongoose"); // ✅ Import mongoose
const Notification = require("../models/Notification");
const createTokenForUser = require("../services/authentication");
const router = Router();
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { sendVerificationEmail } = require("../services/emailService");
const passport = require("passport");

// Rate limit for authentication
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per window
  message: "Too many login attempts from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit for sending emails (Forgot Password)
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 requests per window
  message: "Too many emails sent from this IP, please try again after an hour",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit for verification tokens (Verify Email, Reset Password)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per window
  message: "Too many verification attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});




const User = require("../models/user");
const Blog = require("../models/blog");
const Comment = require("../models/comment");
const redirectIfAuthenticated = require("../middleware/redirectIfAuthenticated");
// ... (imports are handled, just updating the relevant chunks below)

// view other user profile
router.get("/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).send("Invalid user ID");
    }

    const user = await User.findById(userId).select("-password -salt -verificationToken -resetPasswordToken");
    if (!user) return res.status(404).send("User not found");

    const blogs = await Blog.find({ createdBy: user._id }).sort({ createdAt: -1 });

    let isOwnProfile = false;

    // ✅ Check if user is logged in
    if (req.cookies.token) {
      try {
        const decoded = jwt.verify(req.cookies.token, process.env.JWT_SECRET);
        if (decoded._id.toString() === userId) {
          isOwnProfile = true;
        }
      } catch (err) {
        console.error("❌ Token Verification Failed:", err);
      }
    }

    // Calculate Stats
    const totalLikes = blogs.reduce((acc, blog) => acc + (blog.likes ? blog.likes.length : 0), 0);

    // Count comments on these blogs
    const blogIds = blogs.map(b => b._id);
    const totalComments = await Comment.countDocuments({ blogId: { $in: blogIds } }); // Comments received on their blogs

    // ✅ Pass `isOwnProfile` to EJS
    if (isOwnProfile) {
      return res.render("profile", {
        user,
        blogs,
        isAuthenticated: !!req.user,
        isOwnProfile,
        blogCount: blogs.length,
        totalLikes,
        totalComments,
        bookmarks: user.bookmarks, // Private profile needs bookmarks
        searchQuery: ""
      });
    } else {
      return res.render("visitprofile", {
        user,
        blogs,
        isOwnProfile,
        blogCount: blogs.length,
        totalLikes,
        totalComments,
        loggedInUser: req.user, // Pass the logged-in user explicitly
        searchQuery: ""
      });
    }

  } catch (error) {
    console.error("❌ Error fetching profile:", error);
    res.status(500).send("Server error");
  }
});

// check bookmark status (for UI button)
router.get("/check-bookmark/:blogId", async (req, res) => {
  if (!req.user) return res.json({ isBookmarked: false });

  try {
    const user = await User.findById(req.user._id);
    const isBookmarked = user.bookmarks.includes(req.params.blogId);
    res.json({ isBookmarked });
  } catch (error) {
    console.error("❌ Error checking bookmark:", error);
    res.status(500).json({ isBookmarked: false });
  }
});

// 🔖 Toggle Bookmark Route
router.post("/bookmark/:blogId", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { blogId } = req.params;
    const user = await User.findById(req.user._id);

    const isBookmarked = user.bookmarks.includes(blogId);

    if (isBookmarked) {
      // Remove
      await User.findByIdAndUpdate(req.user._id, { $pull: { bookmarks: blogId } });
    } else {
      // Add
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { bookmarks: blogId } });
    }

    return res.json({ success: true, isBookmarked: !isBookmarked });

  } catch (error) {
    console.error("Bookmark Error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
});

// 🔖 View Bookmarks Page
router.get("/bookmarks", async (req, res) => {
  if (!req.user) return res.redirect("/user/signin");

  try {
    const user = await User.findById(req.user._id).populate({
      path: "bookmarks",
      populate: { path: "createdBy", select: "fullName" } // Populate author of bookmarked blogs
    });

    // If a blog was deleted, it might be null in the array (if not handled by middleware). 
    // Filter out nulls just in case.
    const bookmarks = user.bookmarks.filter(b => b !== null);

    res.render("bookmarks", {
      user: req.user,
      bookmarks,
      currentPage: 'bookmarks' // for nav highlighting if needed
    });
  } catch (error) {
    console.error("Error fetching bookmarks:", error);
    res.redirect("/");
  }
});

// Profile Edit - GET Form
router.get("/edit", async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.redirect("/user/signin");

    // Check cooldown before rendering form
    const now = new Date();
    const cooldownPeriod = 24 * 60 * 60 * 1000;

    if (user.lastProfileEdit) {
      const timeSinceLastEdit = now - new Date(user.lastProfileEdit);
      if (timeSinceLastEdit < cooldownPeriod) {
        const remainingHours = Math.ceil((cooldownPeriod - timeSinceLastEdit) / (1000 * 60 * 60));
        // Use flash message for toaster
        req.flash("error", `You can update your profile in ${remainingHours} hours.`);
        return res.redirect("/user/profile");
      }
    }

    res.render("editprofile", { user });
  } catch (err) {
    console.error(err);
    res.redirect("/user/profile");
  }
});

const multer = require("multer");
const { storage } = require("../config/cloudConfig");
const upload = multer({ storage: storage });

// ... (existing code) ...

// Profile Edit - POST Update
router.post("/edit-profile", upload.single("profilePic"), async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      // If coming from a form submit, returning JSON might be handled by client JS, 
      // but if it's a standard submit, we should ideally redirect or render. 
      // Keeping JSON for consistency with previous logic, but client needs to handle it.
      return res.status(401).json({ error: "Unauthorized access!" });
    }

    const { fullName, email, bio, socials = {} } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ error: "User not found!" });
    }

    // Check cooldown
    const now = new Date();
    const cooldownPeriod = 24 * 60 * 60 * 1000; // 24 hours

    if (user.lastProfileEdit) {
      const timeSinceLastEdit = now - new Date(user.lastProfileEdit);
      if (timeSinceLastEdit < cooldownPeriod) {
        const remainingHours = Math.ceil((cooldownPeriod - timeSinceLastEdit) / (1000 * 60 * 60));
        return res.status(403).json({ error: `You can update your profile in ${remainingHours} hours.` });
      }
    }

    // Validate inputs
    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ error: "Full name cannot be empty." });
    }

    // Update fields
    user.fullName = fullName.trim();
    // user.email = email.trim(); // Prevent email change for simplicity/security for now? Or keep it. 
    // If allowing email change, should check for uniqueness catch block.
    if (email) user.email = email.trim();

    user.bio = bio ? bio.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";

    // Socials - parse if it comes as string or object (depends on body parser extended true/false)
    // EJS form sends socials[linkedin], express.urlencoded({extended: true}) parses it as object.

    // Handling socials manually to be safe or assuming extended:true is set in app.js
    if (socials) {
      user.socials = {
        linkedin: socials.linkedin || "",
        twitter: socials.twitter || "",
        github: socials.github || "",
        instagram: socials.instagram || "",
      };
    }

    // ✅ Update Profile Pic if uploaded
    if (req.file) {
      user.profilePic = req.file.path;
    }

    user.lastProfileEdit = new Date(); // Update timestamp

    await user.save();

    // Return success
    return res.status(200).json({ success: "Profile updated successfully!" });

  } catch (error) {
    console.error("Profile Edit Error:", error);
    return res.status(500).json({ error: "Something went wrong!" });
  }
});
//profile
router.get("/profile", async (req, res) => {
  if (!req.cookies.token) {
    return res.status(401).send("No token found, authentication failed.");
  }

  try {
    const decoded = jwt.verify(req.cookies.token, process.env.JWT_SECRET);
    const user = await User.findById(decoded._id).populate("bookmarks").select("-password -salt -verificationToken -resetPasswordToken");
    if (!user) {
      return res.status(404).send("User not found");
    }

    const userId = new mongoose.Types.ObjectId(user._id);

    // Fetch blog count, total likes, and monthly activity in one query
    const blogStats = await Blog.aggregate([
      { $match: { createdBy: userId } },
      {
        $group: {
          _id: { $month: "$createdAt" },
          blogs: { $sum: 1 },
          totalLikes: { $sum: "$likes" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    // Initialize default values for all 12 months
    const activityData = Array.from({ length: 12 }, () => ({ blogs: 0, totalLikes: 0, comments: 0 }));

    // Populate activityData with fetched values
    blogStats.forEach(entry => {
      activityData[entry._id - 1].blogs = entry.blogs;
      activityData[entry._id - 1].totalLikes = entry.totalLikes;
    });

    // Fetch full blog details for display
    const userBlogs = await Blog.find({ createdBy: userId }).sort({ createdAt: -1 });
    const blogIds = userBlogs.map(blog => blog._id);
    const blogCount = userBlogs.length;

    // Fetch total comments and monthly comment activity
    const commentStats = await Comment.aggregate([
      { $match: { blogId: { $in: blogIds } } },
      {
        $group: {
          _id: { $month: "$createdAt" },
          totalComments: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    // Add comment data to activityData
    commentStats.forEach(entry => {
      activityData[entry._id - 1].comments = entry.totalComments;
    });

    // Count total comments
    const totalComments = commentStats.reduce((sum, entry) => sum + entry.totalComments, 0);

    // ✅ Pass Data to EJS
    res.render("profile", {
      user,
      blogCount,
      totalLikes: activityData.reduce((sum, entry) => sum + entry.totalLikes, 0), // Summing up likes
      totalComments,
      monthlyActivity: activityData, // Send to frontend for D3.js
      bookmarks: user.bookmarks,
      blogs: userBlogs, // Pass written blogs to view
      searchQuery: ""
    });

  } catch (error) {
    console.error("❌ Error verifying token:", error);
    res.status(500).send("Something went wrong");
  }
});

// Follow a user
router.post("/follow/:userId", async (req, res) => {
  try {
    if (!req.user) {
      console.error("❌ Error: User not logged in");
      req.flash("error", "You must be logged in to follow!");
      return res.redirect("back");
    }

    const userToFollow = await User.findById(req.params.userId).exec();
    const user = await User.findById(req.user._id).exec();

    if (!userToFollow) {
      console.error(`❌ Error: User to follow not found (ID: ${req.params.userId})`);
      req.flash("error", "User not found!");
      return res.redirect("back");
    }

    if (!user) {
      console.error(`❌ Error: Requesting user not found (ID: ${req.user._id})`);
      req.flash("error", "Something went wrong. Please try again!");
      return res.redirect("back");
    }

    // Ensure `user.following` is an array
    if (!Array.isArray(user.following)) {
      console.warn(`⚠️ Warning: user.following is not an array for user ${user._id}`);
      user.following = [];
    }

    const isFollowing = user.following.includes(userToFollow._id.toString());

    if (isFollowing) {
      // ✅ Unfollow Logic
      await Promise.all([
        User.findByIdAndUpdate(user._id, { $pull: { following: userToFollow._id } }).exec(),
        User.findByIdAndUpdate(userToFollow._id, { $pull: { followers: user._id } }).exec(),
        Notification.findOneAndDelete({
          userId: userToFollow._id,
          senderId: user._id,
          type: "follow",
        }).exec(),
      ]);

      req.flash("success", `You have unfollowed ${userToFollow.fullName}.`);
      console.log(`✅ ${user.fullName} unfollowed ${userToFollow.fullName}`);
    } else {
      // ✅ Follow Logic
      await Promise.all([
        User.findByIdAndUpdate(user._id, { $addToSet: { following: userToFollow._id } }).exec(),
        User.findByIdAndUpdate(userToFollow._id, { $addToSet: { followers: user._id } }).exec(),
      ]);

      // 🔔 Create a follow notification
      const notification = new Notification({
        userId: userToFollow._id,
        senderId: user._id,
        type: "follow",
        message: `${user.fullName} started following you.`,
        createdAt: new Date(),
        read: false,
      });

      await notification.save();

      // 📢 Emit real-time notification
      const io = req.app.get("io");
      if (io) {
        io.to(`user:${userToFollow._id}`).emit("new_notification", {
          message: `${user.fullName} started following you.`,
        });
      } else {
        console.warn("⚠️ Warning: Socket.io is not initialized.");
      }

      req.flash("success", `You are now following ${userToFollow.fullName}!`);
      console.log(`✅ ${user.fullName} started following ${userToFollow.fullName}`);
    }

    return res.redirect("back");
  } catch (err) {
    console.error("❌ Follow Error:", err);
    req.flash("error", "Something went wrong. Please try again!");
    return res.redirect("back");
  }
});

router.get("/signin", authLimiter, redirectIfAuthenticated, (req, res) => {
  return res.render("signin", {
    title: "Sign In - Lumina",
    metaDescription: "Welcome back to Lumina. Log in to continue your journey."
  });
});

router.post("/signin", authLimiter, async (req, res) => {
  let { email, password, captcha } = req.body;

  // Prevent NoSQL Injection
  email = String(email);
  password = String(password);

  try {
    // Verify CAPTCHA first
    if (!req.session.captcha) {
      return res.status(400).render("signin", { error: "CAPTCHA expired. Please try again." });
    }

    if (!captcha || captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
      return res.status(400).render("signin", { error: "Incorrect CAPTCHA. Please try again." });
    }

    // Clear the captcha from session after verification
    req.session.captcha = null;

    // Check verification status
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).render("signin", { error: "Invalid Email or Password" });
    }

    if (!user.isVerified) {
      // 🔄 Auto-Resend Verification Logic
      const verificationToken = crypto.randomBytes(32).toString("hex");
      user.verificationToken = verificationToken;
      user.verificationTokenExpires = Date.now() + 24 * 60 * 60 * 1000;
      await user.save();

      try {
        await sendVerificationEmail(email, verificationToken);
        return res.render("verify-sent");
      } catch (error) {
        console.error("Email Error:", error);
        return res.render("signin", { error: "Please verify your email. (Could not resend email)" });
      }
    }

    // Proceed with authentication
    // Note: matchPasswordAndGenerateToken verifies password too, so we don't need to do it twice
    // But since we already fetched user, we can optimization logic if needed. 
    // For now, sticking to existing method call for simplicity, or we can use the user object we just fetched.

    // Actually, matchPasswordAndGenerateToken does a findOne again. 
    // Let's optimize slightly by checking password here manually if we wanted, 
    // but sticking to the existing function call is safer to avoid breaking changes.
    const token = await User.matchPasswordAndGenerateToken(email, password);

    // 🛡️ Security: Regenerate Session ID to prevent fixation attacks
    req.session.regenerate((err) => {
      if (err) console.error("Session Regeneration Error:", err);

      // Store new session data if needed (e.g., user info slightly)
      // For now, we rely on JWT, but this rotates the connect.sid

      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
        path: "/",
        maxAge: 86400 * 1000,
      });

      return res.redirect("/");
    });
  } catch (error) {
    console.error("❌ Error during sign-in:", error);
    return res.status(401).render("signin", { error: "Invalid Email or Password" });
  }
});

// 🔹 Google Authentication Routes
router.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

router.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/user/signin" }),
  async (req, res) => {
    // Successful authentication
    // Generate our JWT token so it works with our existing system

    // Create token manually since Google users are already verified
    const payload = {
      _id: req.user._id,
      email: req.user.email,
      profilePic: req.user.profilePic,
      role: req.user.role,
    };
    const jwtToken = jwt.sign(payload, process.env.JWT_SECRET);

    // 🛡️ Security: Regenerate Session ID
    req.session.regenerate((err) => {
      if (err) console.error("Session Regeneration Error:", err);

      res.cookie("token", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
        path: "/",
        maxAge: 86400 * 1000,
      });

      res.redirect("/");
    });
  }
);

router.get("/signup", redirectIfAuthenticated, (req, res) => {
  return res.render("signup", {
    title: "Join Lumina - Start Writing",
    metaDescription: "Create an account on Lumina to share your stories and connect with the world."
  });
});

const PendingUser = require("../models/pendingUser");

// ... (existing imports)

router.post("/signup", authLimiter, async (req, res) => {
  let { fullName, email, password } = req.body;

  // Prevent NoSQL Injection
  fullName = String(fullName);
  email = String(email);
  password = String(password);

  // Check if fully verified user already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.render("signup", { error: "User already exists." });
  }

  // Check if pending user exists
  const pendingUser = await PendingUser.findOne({ email });
  if (pendingUser) {
    // Resend verification logic for pending user
    const verificationToken = crypto.randomBytes(32).toString("hex");
    pendingUser.verificationToken = verificationToken;
    pendingUser.verificationTokenExpires = Date.now() + 24 * 60 * 60 * 1000;
    await pendingUser.save();

    try {
      await sendVerificationEmail(email, verificationToken);
      return res.render("verify-sent", { email });
    } catch (error) {
      console.error("Email Error:", error);
      return res.render("signup", { error: "Error sending verification email." });
    }
  }

  // 🔒 Security: Validate Password Strength
  if (password.length < 6) {
    return res.render("signup", { error: "Password must be at least 6 characters long." });
  }

  // 🔒 Security: Validate Email Format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.render("signup", { error: "Please enter a valid email address." });
  }

  // Generate a random avatar for the user
  const avatarUrl = `https://api.dicebear.com/8.x/bottts/svg?seed=${encodeURIComponent(email)}`;

  // Generate verification token
  const verificationToken = crypto.randomBytes(32).toString("hex");

  // Hashing is handled by User model pre-save, but PendingUser needs manual hashing or similar pre-save? 
  // Wait, PendingUser schema I created earlier DOES NOT have encryption logic.
  // I should add hashing to PendingUser or hash manually here.
  // Let's hash manually here to be safe and simple, relying on crypto.

  const salt = crypto.randomBytes(16).toString("hex");
  const hashedPassword = crypto.createHmac("sha256", salt)
    .update(password)
    .digest("hex");

  await PendingUser.create({
    fullName,
    email,
    password: hashedPassword, // Store hashed
    salt,
    profilePic: avatarUrl,
    verificationToken,
    verificationTokenExpires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });

  // Send verification email
  try {
    await sendVerificationEmail(email, verificationToken);
    return res.render("verify-sent", { email });
  } catch (error) {
    console.error("Email Error:", error);
    return res.render("signup", { error: "Error sending verification email." });
  }
});

// Verify Email Route
router.get("/verify/:token", verifyLimiter, async (req, res) => {
  try {
    // 1. Check PendingUser first
    const pendingUser = await PendingUser.findOne({
      verificationToken: req.params.token,
      verificationTokenExpires: { $gt: Date.now() },
    });

    if (!pendingUser) {
      return res.render("signin", { error: "Invalid or expired verification token." });
    }

    // 2. Move to Real User Collection
    // 2. Move to Real User Collection
    const newUser = new User({
      fullName: pendingUser.fullName,
      email: pendingUser.email,
      password: pendingUser.password, // Already hashed
      salt: pendingUser.salt,
      profilePic: pendingUser.profilePic,
      isVerified: true,
      role: "USER"
    });

    // Skip hashing because it's already hashed in PendingUser
    newUser._skipHash = true;
    await newUser.save();

    // 3. Delete from Pending
    await PendingUser.deleteOne({ _id: pendingUser._id });

    // 4. Auto-login: Generate Token
    const payload = {
      _id: newUser._id,
      email: newUser.email,
      profilePic: newUser.profilePic,
      role: newUser.role,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      path: "/",
      maxAge: 86400 * 1000,
    });

    return res.redirect("/");
  } catch (error) {
    console.error("Verification Error:", error);
    return res.render("signin", { error: "Something went wrong during verification." });
  }
});

router.get("/forgot-password", (req, res) => {
  res.render("forgot-password");
});

router.post("/forgot-password", emailLimiter, async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      // Catch 1: If user not found, show error
      req.flash("error", "No account found with this email address.");
      return res.redirect("/user/forgot-password");
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send Reset Email
    const baseUrl = process.env.BASE_URL || `http://${req.headers.host}`;
    const resetLink = `${baseUrl}/user/reset-password/${token}`;
    const transporter = await require("../services/emailService").createTransporter(); // Assuming export, or I need to import createTransporter properly if not exported. 
    // Wait, createTransporter is internal in emailService. Let's add a sendResetPasswordEmail function to emailService.js instead.
    // For now, I will use sendVerificationEmail style logic inside emailService.

    await require("../services/emailService").sendResetPasswordEmail(email, resetLink);

    // Render the confirmation page instead of redirecting
    return res.render("reset-sent", { email });

  } catch (error) {
    console.error("Forgot Password Error:", error);
    req.flash("error", "Something went wrong.");
    return res.redirect("/user/forgot-password");
  }
});

router.get("/reset-password/:token", async (req, res) => {
  try {
    const user = await User.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      req.flash("error", "Password reset token is invalid or has expired.");
      return res.redirect("/user/forgot-password");
    }

    res.render("reset-password", { token: req.params.token });
  } catch (error) {
    console.error("Reset Page Error:", error);
    res.redirect("/user/forgot-password");
  }
});

router.post("/reset-password/:token", verifyLimiter, async (req, res) => {
  const { password, confirmPassword } = req.body;

  if (password !== confirmPassword) {
    req.flash("error", "Passwords do not match.");
    return res.redirect(`/user/reset-password/${req.params.token}`);
  }

  if (password.length < 6) {
    req.flash("error", "Password must be at least 6 characters long.");
    return res.redirect(`/user/reset-password/${req.params.token}`);
  }

  try {
    const user = await User.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      req.flash("error", "Password reset token is invalid or has expired.");
      return res.redirect("/user/forgot-password");
    }

    // Update password
    user.password = password; // Pre-save hook will hash it
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    req.flash("success", "Password has been updated! You can now sign in.");
    return res.redirect("/user/signin");
  } catch (error) {
    console.error("Reset Password Error:", error);
    req.flash("error", "Something went wrong.");
    return res.redirect("/user/forgot-password");
  }
});

router.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    return res.clearCookie("token").redirect("/");
  });
});

module.exports = router;
