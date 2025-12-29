const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const compression = require("compression"); // 🚀 Performance
const logger = require("./services/logger"); // 📝 Structured Logger
const cookieParser = require("cookie-parser");
const app = express();
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const svgCaptcha = require("svg-captcha");
const mongoose = require("mongoose");
const moment = require("moment");
const flash = require("connect-flash");
const { cosineSimilarity } = require("./services/ai");
const { optimizeImage } = require("./services/imageHelper");
const aiRoute = require("./routes/ai");
const socketio = require("socket.io");
const helmet = require("helmet");
const passport = require("passport"); // ✅ Required since we use passport.initialize()
require("./services/passport"); // ✅ Import the strategy configuration


const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const checkForAuthenticationCookie = require("./middleware/authentication");

const Blog = require("./models/blog");
const Comment = require("./models/comment");
const User = require("./models/user");
const Notification = require("./models/Notification");

const userRoute = require("./routes/user");
const blogRoute = require("./routes/blog");
const subscriptionRoute = require("./routes/subscription");
const notificationsRoute = require("./routes/notifications");
const staticRoute = require("./routes/static");
const adminRoute = require("./routes/admin"); // 🛡️ Import Admin Route

// MongoDB Connection
const URI = process.env.MONGODB_URL || "mongodb://localhost:27017/blogiFy";
if (!URI) {
  throw new Error("❌ MONGODB_URL is not defined in .env. Please add it.");
}


mongoose
  .connect(URI)
  .then(() => logger.info("✅ MongoDB connected successfully."))
  .catch((error) => logger.error("❌ Error connecting to MongoDB:", error.message));

// Optional MongoClient ping check (non-blocking)
const { MongoClient, ServerApiVersion } = require("mongodb");
const testClient = new MongoClient(URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function pingMongoDB() {
  try {
    await testClient.connect();
    await testClient.db("admin").command({ ping: 1 });
    console.log("✅ Pinged your MongoDB deployment successfully.");
  } catch (err) {
    console.error("❌ MongoDB ping failed:", err.message);
  } finally {
    await testClient.close();
  }
}

pingMongoDB();

const port = process.env.PORT || 8000;

// View Engine Setup
app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));

// Trust Proxy for Render/Heroku
app.set("trust proxy", 1);

// Middleware
app.use(compression()); // 🚀 Enable Gzip/Brotli Compression

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://code.jquery.com", "https://kit.fontawesome.com", "https://www.google.com", "https://www.gstatic.com", "https://cdn.quilljs.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://maxcdn.bootstrapcdn.com", "https://kit.fontawesome.com", "https://cdn.quilljs.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://ka-f.fontawesome.com", "https://r2cdn.perplexity.ai"],
      imgSrc: ["'self'", "data:", "https:", "https://api.dicebear.com"],
      connectSrc: ["'self'", "https://ka-f.fontawesome.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
    },
  },
}));
app.use(cookieParser());

app.use(checkForAuthenticationCookie("token"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🚀 Static Asset Caching (1 Year)
app.use(express.static(path.resolve("./public"), {
  maxAge: '1y',
  etag: false
}));
// Removing redundant express.static("public") call
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.path = req.path;
  app.locals.optimizeImage = optimizeImage;
  next();
});



// Add session store error handling
const sessionStore = MongoStore.create({
  mongoUrl: URI,
  ttl: 24 * 60 * 60,
  crypto: {
    secret: process.env.SESSION_SECRET || 'your-secret-key'
  },
  autoRemove: 'native',
  touchAfter: 24 * 3600
});

sessionStore.on('error', function (error) {
  console.error('Session Store Error:', error);
});

// Session Configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    store: sessionStore
  })
);

app.use(passport.initialize());
app.use(passport.session()); // Persistent login sessions

app.use(flash());
app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success");
  res.locals.error_msg = req.flash("error");
  res.locals.error = res.locals.error_msg; // Alias for compatibility with signin/signup
  next();
});

// 📢 Middleware: Fetch Global Announcement
const Announcement = require("./models/announcement");
app.use(async (req, res, next) => {
  try {
    const announcement = await Announcement.findOne({
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).sort({ createdAt: -1 });
    res.locals.announcement = announcement || null;
  } catch (err) {
    console.error("Announcement Middleware Error:", err);
    res.locals.announcement = null;
  }
  next();
});

app.get('/user/edit-profile', (req, res) => {
  res.render('editprofile', {
    user: req.user,  // Assuming you have the user data available
    messages: req.flash()  // Pass flash messages to the EJS view
  });
});




// Smart Root Route
app.get("/", async (req, res) => {
  try {
    // If user is NOT logged in, render the Landing Page (formerly /main)
    if (!req.user) {
      const blogs = await Blog.find()
        .sort({ createdAt: -1 })
        .populate("createdBy", "fullName");

      const featuredBlogs = await Blog.find({ featured: true })
        .sort({ createdAt: -1 })
        .populate("createdBy", "fullName");

      const trendingBlogs = await Blog.find()
        .sort({ views: -1 })
        .limit(3)
        .populate("createdBy", "fullName");

      return res.render("main", {
        blogs,
        featuredBlogs,
        trendingBlogs,
        searchQuery: "",
        moment,
        title: "Lumina - The Voice of the Bold",
        metaDescription: "A minimalist sanctuary where builders share insights and shape the future of tech."
      });
    }

    // If user IS logged in, render the Home Feed (formerly /)
    // Get search and filter values from the query parameters
    const searchQuery = req.query.searchQuery || ""; // Default to empty string
    const categoryFilter = req.query.category ? req.query.category.toLowerCase() : "";
    const tagFilter = req.query.tag ? req.query.tag.toLowerCase() : "";

    let filter = {};
    let sort = { views: 1, createdAt: -1 }; // ⚡ Cold Start: Show "Hidden Gems" (Low views + Recent)

    // Apply search query filter if provided
    if (searchQuery) {
      filter.$text = { $search: searchQuery }; // MongoDB full-text search
      sort = { score: { $meta: "textScore" } }; // Sort by text relevance
    }

    // Apply category filter (case-insensitive)
    if (categoryFilter) {
      if (categoryFilter === 'trending') {
        sort = { views: -1, createdAt: -1 }; // Sort by views for trending
      } else if (categoryFilter === 'featured') {
        filter.featured = true;
        sort = { createdAt: -1 };
      } else if (categoryFilter !== 'all') {
        filter.category = { $regex: new RegExp(categoryFilter, "i") };
        sort = { createdAt: -1 };
      }
    }

    // Apply tag filter (case-insensitive)
    if (tagFilter) {
      filter.tags = { $in: [new RegExp(tagFilter, "i")] };
    }

    let blogs = [];


    // 🧠 Personalization Logic: If no search/filter & user has history
    if (!searchQuery && !categoryFilter && !tagFilter && req.user.readingHistory && req.user.readingHistory.length > 0) {
      try {
        // 1. Get embedding of blogs in history
        const historyIds = req.user.readingHistory.map(h => h.blogId);
        const historyBlogs = await Blog.find({ _id: { $in: historyIds } }).select("embedding");

        // 2. Calculate User Vector (centroid)
        let validEmbeddings = historyBlogs.filter(b => b.embedding && b.embedding.length > 0);

        if (validEmbeddings.length > 0) {
          const vectorSize = validEmbeddings[0].embedding.length;
          const userVector = new Array(vectorSize).fill(0);

          validEmbeddings.forEach(b => {
            b.embedding.forEach((val, i) => userVector[i] += val);
          });

          // Average it
          userVector.forEach((_, i) => userVector[i] /= validEmbeddings.length);

          // ⚡ OPTIMIZATION: Two-Stage Ranking
          // Stage 1: Candidate Generation (Fetch only ID + Embedding)
          // Limit to recent blogs (e.g., last 90 days) for performance
          const ninetyDaysAgo = new Date();
          ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

          const candidates = await Blog.find({
            createdAt: { $gte: ninetyDaysAgo },
            embedding: { $exists: true, $ne: [] }
          }).select("_id embedding"); // Fetch strictly minimal data

          // Stage 2: In-Memory Scoring
          const scoredCandidates = candidates.map(b => {
            const score = cosineSimilarity(userVector, b.embedding);
            return { _id: b._id, score };
          });

          // Sort by score (descending)
          scoredCandidates.sort((a, b) => b.score - a.score);

          // Stage 3: Hydration (Fetch full details only for top 10)
          const topIds = scoredCandidates.slice(0, 10).map(c => c._id);
          const topBlogs = await Blog.find({ _id: { $in: topIds } })
            .populate("createdBy", "fullName profilePic");

          // Re-attach scores and preserve order
          blogs = topBlogs.map(blog => {
            const candidate = scoredCandidates.find(c => c._id.toString() === blog._id.toString());
            return { ...blog.toObject(), score: candidate ? candidate.score : 0 };
          }).sort((a, b) => b.score - a.score);
        }
      } catch (pError) {
        console.error("⚠️ Personalization Error:", pError);
        // Fallback to default fetch if error
      }
    }

    // Fallback: If no personalization (or it failed/empty), fetch standard
    if (blogs.length === 0) {
      blogs = await Blog.find(filter).sort(sort).populate("createdBy", "fullName profilePic");
    }

    const categories = await Blog.distinct("category");
    const tags = await Blog.distinct("tags");

    // Fetch featured and trending blogs
    const featuredBlogs = await Blog.find({ featured: true }).limit(5);
    const trendingBlogs = await Blog.find().sort({ views: -1 }).limit(3);

    // Render the home page
    res.render("home", {
      user: req.user,
      blogs: blogs || [],
      featuredBlogs,
      trendingBlogs,
      categories,
      tags,
      searchQuery,
      categoryFilter,
      tagFilter,
      tagFilter,
      moment,
      title: "Home Feed - Lumina",
      metaDescription: "Discover fresh perspectives and trending stories curated just for you."
    });

  } catch (error) {
    console.error("❌ Error fetching blogs:", error);
    res.status(500).render("error", { message: "An error occurred while fetching blogs." });
  }
});


// Socket.io

const http = require("http"); // Import http module
const socketIo = require("socket.io");

const server = http.createServer(app); // Create HTTP server
const io = socketIo(server); // Create Socket.io server

app.set("io", io);

// WebSocket connections
io.on("connection", (socket) => {
  // console.log("🟢 User connected:", socket.id);

  socket.on("register", (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      // console.log(`✅ User ${userId} joined room: user:${userId}`);
    }
  });
});
module.exports = app;



// CAPTCHA Route
app.get("/captcha", (req, res) => {
  const captcha = svgCaptcha.create({
    size: 5,
    noise: 1,
    color: true,
    background: "#f0f0f0",
    width: 150,
    height: 50,
    fontSize: 50,
    charPreset: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  });

  req.session.captcha = captcha.text;
  res.type("svg").send(captcha.data);
});

// CAPTCHA Verification
app.post("/verify-captcha", (req, res) => {
  if (!req.session.captcha) {
    return res.status(400).json({ error: "⚠️ CAPTCHA expired. Please reload!" });
  }

  if (req.body.captcha !== req.session.captcha) {
    return res.status(400).json({ error: "❌ CAPTCHA Incorrect. Try Again!" });
  }

  req.session.captcha = null; // Clear after success
  res.json({ success: "✅ CAPTCHA Verified Successfully!" });
});

// Routes
app.use("/", staticRoute);
app.use("/blog", blogRoute);
app.use("/user", userRoute);
app.use("/admin", adminRoute); // 🛡️ Mount Admin Route
app.use("/subscription", subscriptionRoute);
app.use("/notifications", notificationsRoute);
app.use("/ai", aiRoute);


// 404 Page
app.get("*", (req, res) => {
  res.render("404");
  res.status(404);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("🔥 Global Error:", err.stack);
  res.status(500).render("error", {
    message: "Something went wrong on our end. We are looking into it!"
  });
});

// Start Server
// Start Server
const serverInstance = server.listen(port, () => logger.info(`🚀 App listening on port ${port}`));

// 🛑 Graceful Shutdown Logic
const gracefulShutdown = () => {
  logger.info("🛑 Received termination signal. Shutting down gracefully...");

  serverInstance.close(() => {
    logger.info("✅ HTTP server closed.");

    mongoose.connection.close()
      .then(() => {
        logger.info("✅ MongoDB connection closed.");
        process.exit(0);
      });
  });

  // Force close after 10s if hanging
  setTimeout(() => {
    logger.error("❌ Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);