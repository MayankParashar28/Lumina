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
const { csrfSync } = require("csrf-sync"); // Maintained, CommonJS, session-based CSRF (Vercel/serverless-safe)
const { cosineSimilarity } = require("./services/ai");
const { optimizeImage } = require("./services/imageHelper");
const aiRoute = require("./routes/ai");
const socketio = require("socket.io");
const helmet = require("helmet");
const passport = require("passport"); // ✅ Required since we use passport.initialize()
require("./services/passport"); // ✅ Import the strategy configuration


const checkForAuthenticationCookie = require("./middleware/authentication");

const Blog = require("./models/blog");
const Comment = require("./models/comment");
const User = require("./models/user");
const Notification = require("./models/Notification");

const userRoute = require("./routes/user");
const blogRoute = require("./routes/blog");
const notificationsRoute = require("./routes/notifications");
const staticRoute = require("./routes/static");
const adminRoute = require("./routes/admin"); // 🛡️ Import Admin Route

// MongoDB Connection
const URI = process.env.MONGODB_URL || "mongodb://localhost:27017/blogiFy";
if (!URI) {
  throw new Error("❌ MONGODB_URL is not defined in .env. Please add it.");
}


// In tests, the test suite manages its own in-memory MongoDB connection.
if (process.env.NODE_ENV !== "test") {
  mongoose
    .connect(URI)
    .then(() => logger.info("✅ MongoDB connected successfully."))
    .catch((error) => logger.error("❌ Error connecting to MongoDB:", error.message));
}

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
    logger.info("✅ Pinged your MongoDB deployment successfully.");
  } catch (err) {
    logger.error("❌ MongoDB ping failed:", err.message);
  } finally {
    await testClient.close();
  }
}

// Diagnostic only — skip in production (avoids a second DB connection on every
// serverless cold start) and in tests.
if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") pingMongoDB();

const port = process.env.PORT || 8000;

// View Engine Setup
app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));

// Trust Proxy for Render/Heroku
app.set("trust proxy", 1);

// Middleware
app.use(compression()); // 🚀 Enable Gzip/Brotli Compression

// 🔐 Per-request CSP nonce for inline <script> blocks. This lets us drop
// 'unsafe-inline' and 'unsafe-eval' from script-src (so injected <script>
// tags can't execute). Must run before helmet so the directive can read it.
const crypto = require("crypto");
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://kit.fontawesome.com",
        "https://www.googletagmanager.com",
        "https://analytics.ahrefs.com",
        "https://cdn.quilljs.com",
        "https://unpkg.com"
      ],
      scriptSrcAttr: ["'none'"], // inline event handlers fully removed (delegated via /javascript/app.js)
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://maxcdn.bootstrapcdn.com",
        "https://kit.fontawesome.com",
        "https://cdn.quilljs.com",
        "https://unpkg.com"
      ],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://ka-f.fontawesome.com", "https://r2cdn.perplexity.ai"],
      imgSrc: ["'self'", "data:", "https:", "https://api.dicebear.com"],
      connectSrc: [
        "'self'",
        "https://ka-f.fontawesome.com",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://unpkg.com",
        "https://analytics.ahrefs.com",
        "https://www.google-analytics.com",
        "https://region1.google-analytics.com"
      ],
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
  res.locals.canonicalPath = req.path; // 🔍 SEO: Canonical URL for all pages
  app.locals.optimizeImage = optimizeImage;

  // 🔍 SEO: Set default title & meta based on route patterns
  const seoDefaults = {
    '/': { title: 'Lumina - The Voice of the Bold', metaDescription: 'Discover fresh perspectives and trending stories on technology, creativity, and innovation. Join the vibrant community of bold thinkers and creators today!...' },
    '/user/signin': { title: 'Sign In - Lumina', metaDescription: 'Sign in to your Lumina account to read, write, and share your unique stories with the world. Join our growing community of passionate creators today!...', noIndex: true },
    '/user/signup': { title: 'Sign Up - Lumina', metaDescription: 'Create your free Lumina account and start publishing your stories to a global audience. Experience a minimalist platform designed for focused writing!...', noIndex: true },
    '/user/forgot-password': { title: 'Forgot Password - Lumina', metaDescription: 'Reset your Lumina account password securely to regain access to your profile, saved stories, and personalized reading recommendations from our platform!...', noIndex: true },
    '/user/profile': { title: 'My Profile - Lumina', metaDescription: 'Manage your Lumina profile, view your published stories, track your reading activity, and connect with other writers in our vibrant creative community!...', noIndex: true },
    '/user/edit-profile': { title: 'Edit Profile - Lumina', metaDescription: 'Update your Lumina profile settings, bio, and social links to customize how you present your stories and connect with our passionate reading community!...', noIndex: true },
    '/user/bookmarks': { title: 'My Bookmarks - Lumina', metaDescription: 'Access your saved reading list on Lumina. Revisit your favorite stories, essays, and articles collected from our diverse community of brilliant writers!...', noIndex: true },
    '/blog/add-new': { title: 'New Story - Lumina', metaDescription: 'Write and publish a new story on Lumina. Our distraction-free editor helps you focus on your ideas and share your unique perspective with the world!...', noIndex: true },
    '/blog/drafts': { title: 'My Drafts - Lumina', metaDescription: 'Continue working on your unpublished drafts. Refine your ideas, preview your formatting, and prepare your next great story for publication on Lumina!...', noIndex: true },
    '/about': { title: 'About - Lumina', metaDescription: 'Learn about Lumina — the minimalist blogging platform where ideas come to life. Discover our mission to empower creators and foster meaningful conversations!...', },
    '/privacy': { title: 'Privacy Policy - Lumina', metaDescription: 'Read how Lumina protects your data and respects your privacy. Understand our commitment to securing your personal information and writing content securely!...', },
    '/terms': { title: 'Terms of Service - Lumina', metaDescription: 'Review the terms and conditions for using the Lumina platform. Learn about our community guidelines and policies for publishing and interacting safely!...', },
    '/notifications': { title: 'Notifications - Lumina', metaDescription: 'Stay updated with your latest interactions on Lumina. Track comments, likes, and follows from the community on your published stories and insightful replies!...', noIndex: true },
    '/admin': { title: 'Admin Dashboard - Lumina', metaDescription: 'Access the Lumina admin control panel to manage users, review platform analytics, and oversee content moderation for a safe community experience online!...', noIndex: true },
    '/admin/moderation': { title: 'Moderation Logs - Lumina Admin', metaDescription: 'Review flagged content and moderation actions on Lumina. Help maintain a positive, safe, and welcoming environment for all readers and passionate writers!...', noIndex: true },
  };

  const defaults = seoDefaults[req.path];
  if (defaults) {
    if (!res.locals.title) res.locals.title = defaults.title;
    if (!res.locals.metaDescription) res.locals.metaDescription = defaults.metaDescription;
    if (defaults.noIndex) res.locals.noIndex = true;
  }

  next();
});



// Add session store error handling
if (!process.env.SESSION_SECRET) {
  throw new Error("❌ SESSION_SECRET is not defined in .env. Please add it to secure sessions.");
}

const sessionStore = MongoStore.create({
  mongoUrl: URI,
  ttl: 24 * 60 * 60,
  crypto: {
    secret: process.env.SESSION_SECRET
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
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // 🔒 Fixed: Don't create sessions for anonymous visitors
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // 🔒 Only require HTTPS in production so local HTTP dev works
      sameSite: "lax",
    }
  })
);

// CSRF Protection — session-based; token comes from the _csrf form field, the
// x-csrf-token header, or the _csrf query param. The query param is needed for
// multipart/form-data posts (new/edit blog): their body isn't parsed until multer
// runs inside the route, which is AFTER this global CSRF check, so the token is
// passed on the action URL instead.
const { generateToken, csrfSynchronisedProtection } = csrfSync({
  getTokenFromRequest: (req) =>
    (req.body && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"],
});
const csrfProtection = csrfSynchronisedProtection;

app.use((req, res, next) => {
  if (req.path === "/ai/generate-comment-suggestions") {
    return next();
  }
  csrfProtection(req, res, next);
});

app.use(passport.initialize());
app.use(passport.session()); // Persistent login sessions

app.use(flash());
app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success");
  res.locals.error_msg = req.flash("error");
  res.locals.error = res.locals.error_msg; // Alias for compatibility with signin/signup
  res.locals.csrfToken = generateToken(req); // 🛡️ CSRF Token for all forms
  next();
});



app.get('/user/edit-profile', (req, res) => {
  res.render('editprofile', {
    user: req.user,  // Assuming you have the user data available
    messages: req.flash()  // Pass flash messages to the EJS view
  });
});




// ⚡ Cache slowly-changing taxonomy (categories / tags / trending tags) used on
// every home render. Refreshes at most once every 5 minutes.
let _taxoCache = { data: null, ts: 0 };
const TAXONOMY_TTL = 5 * 60 * 1000;
async function getTaxonomy() {
  if (_taxoCache.data && Date.now() - _taxoCache.ts < TAXONOMY_TTL) return _taxoCache.data;
  const [categories, tags, trendingTagsList] = await Promise.all([
    Blog.distinct("category"),
    Blog.distinct("tags"),
    Blog.getTrendingTags(),
  ]);
  _taxoCache = { data: { categories, tags, trendingTagsList }, ts: Date.now() };
  return _taxoCache.data;
}

// Smart Root Route
app.get("/", async (req, res) => {
  try {
    // If user is NOT logged in, render the Landing Page (formerly /main)
    if (!req.user) {
      const blogs = await Blog.find({ status: "published" })
        .sort({ createdAt: -1 })
        .select("-body")
        .populate("createdBy", "fullName profilePic") // Added profilePic for consistency if needed
        .lean();

      const featuredBlogs = await Blog.find({ featured: true, status: "published" })
        .sort({ createdAt: -1 })
        .select("-body")
        .populate("createdBy", "fullName profilePic")
        .lean();

      const trendingBlogs = await Blog.find({ status: "published" })
        .sort({ views: -1 })
        .limit(3)
        .select("-body")
        .populate("createdBy", "fullName profilePic")
        .lean();

      return res.render("main", {
        blogs,
        featuredBlogs,
        trendingBlogs,
        searchQuery: "",
        moment,
        title: "Lumina - The Voice of the Bold",
        metaDescription: "A minimalist sanctuary where builders share insights and shape the future of tech. Join us to read, write, and explore the bleeding edge of innovation!..."
      });
    }

    // If user IS logged in, render the Home Feed (formerly /)
    // Get search and filter values from the query parameters
    const searchQuery = req.query.searchQuery || ""; // Default to empty string
    const categoryFilter = req.query.category ? req.query.category.toLowerCase() : "";
    const tagFilter = req.query.tag ? req.query.tag.toLowerCase() : "";

    let filter = { status: "published" }; // ✅ Only show published blogs
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
        // 1. Get embedding of blogs in history (select +embedding to override schema default)
        const historyIds = req.user.readingHistory.map(h => h.blogId);
        const historyBlogs = await Blog.find({ _id: { $in: historyIds } }).select("+embedding").lean();

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
          const ninetyDaysAgo = new Date();
          ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
          const candidates = await Blog.find({
            status: "published",
            createdAt: { $gte: ninetyDaysAgo },
            embedding: { $exists: true, $ne: [] }
          }).select("_id +embedding").lean(); // Fetch strictly minimal data

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
            .select("-body")
            .populate("createdBy", "fullName profilePic")
            .lean();

          // Re-attach scores and preserve order
          blogs = topBlogs.map(blog => {
            const candidate = scoredCandidates.find(c => c._id.toString() === blog._id.toString());
            return { ...blog, score: candidate ? candidate.score : 0 };
          }).sort((a, b) => b.score - a.score);
        }
      } catch (pError) {
        console.error("⚠️ Personalization Error:", pError);
        // Fallback to default fetch if error
      }
    }

    // Pagination Setup
    const page = parseInt(req.query.page) || 1;
    const limit = 8; // Number of blogs per page
    const skip = (page - 1) * limit;

    // Fallback: If no personalization (or it failed/empty), fetch standard
    if (blogs.length === 0) {
      const totalBlogs = await Blog.countDocuments(filter);
      const totalPages = Math.ceil(totalBlogs / limit);

      blogs = await Blog.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .select("-body") // 📉 Optimization: Don't load full text
        .populate("createdBy", "fullName profilePic")
        .lean(); // ⚡ Optimization: Return plain JSON

      res.locals.pagination = { currentPage: page, totalPages }; // Pass to layout
    } else {
      // If personalized blogs exist, we should manually slice them for consistency?
      // For now, let's just paginate the 'standard' flow as it's the main issue.
      // If personalization returns 10 items, that's effectively one page.
      res.locals.pagination = null;
    }

    const { categories, tags, trendingTagsList } = await getTaxonomy(); // ⚡ cached (5 min)

    // Fetch featured and trending blogs
    const featuredBlogs = await Blog.find({ featured: true, status: "published" })
      .limit(5)
      .select("-body")
      .populate("createdBy", "fullName profilePic")
      .lean();

    const trendingBlogs = await Blog.find({ status: "published" })
      .sort({ views: -1 })
      .limit(3)
      .select("-body")
      .populate("createdBy", "fullName profilePic")
      .lean();

    // 🕘 "Continue reading": the user's last few distinct read blogs (newest first).
    let recentlyRead = [];
    if (req.user.readingHistory && req.user.readingHistory.length > 0) {
      const distinctIds = [...new Set(
        [...req.user.readingHistory]
          .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
          .map(h => h.blogId.toString())
      )].slice(0, 4);
      const found = await Blog.find({ _id: { $in: distinctIds }, status: "published" })
        .select("-body")
        .populate("createdBy", "fullName profilePic")
        .lean();
      recentlyRead = distinctIds
        .map(id => found.find(b => b._id.toString() === id))
        .filter(Boolean);
    }

    // Render the home page
    res.render("home", {
      user: req.user,
      blogs: blogs || [],
      featuredBlogs,
      trendingBlogs,
      recentlyRead,
      trendingTagsList, // Pass to view
      categories,
      tags,
      searchQuery,
      categoryFilter,
      tagFilter,
      moment,
      title: "Home Feed - Lumina",
      metaDescription: "Discover fresh perspectives and trending stories curated just for you. Join the Lumina community to read, write, and connect with visionary creators!..."
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

// Static fallback for socket.io client bundle (ensures /socket.io/socket.io.js never 404s on serverless)
try {
  const socketIoClientDist = path.join(__dirname, "node_modules", "socket.io", "client-dist");
  app.use("/socket.io", express.static(socketIoClientDist));
} catch (e) {
  // Ignore if path not available
}

// WebSocket connections
io.on("connection", (socket) => {
  // console.log("🟢 User connected:", socket.id);

  socket.on("register", (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      // console.log(`✅ User ${userId} joined room: user:${userId}`);
    }
  });

  // 👀 Live co-reading: track readers per blog + broadcast the count
  const broadcastReaderCount = (blogId) => {
    const room = io.sockets.adapter.rooms.get(`blog:${blogId}`);
    io.to(`blog:${blogId}`).emit("reader_count", room ? room.size : 0);
  };

  socket.on("join_blog", (blogId) => {
    if (!blogId) return;
    socket.join(`blog:${blogId}`);
    socket.data.blogId = blogId;
    broadcastReaderCount(blogId);
  });

  // 🎈 Floating live reactions (broadcast to everyone else reading the post)
  const FLOAT_EMOJIS = ["❤️", "🔥", "👏", "😮", "💡", "👍"];
  socket.on("float_reaction", ({ blogId, emoji } = {}) => {
    if (blogId && FLOAT_EMOJIS.includes(emoji)) {
      socket.to(`blog:${blogId}`).emit("float_reaction", { emoji });
    }
  });

  socket.on("disconnect", () => {
    if (socket.data && socket.data.blogId) broadcastReaderCount(socket.data.blogId);
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
app.use("/notifications", notificationsRoute);
app.use("/ai", aiRoute);

// 🗓️ Scheduled publishing
const { publishDueScheduled } = require("./services/scheduler");

// Cron endpoint (for serverless platforms like Vercel Cron). Protected by
// CRON_SECRET when set — accepts it as "Authorization: Bearer <secret>",
// an "x-cron-secret" header, or a "?secret=" query param.
app.get("/cron/publish-scheduled", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (bearer !== secret && req.headers["x-cron-secret"] !== secret && req.query.secret !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  const published = await publishDueScheduled(app.get("io"));
  res.json({ published });
});

// Interval for long-lived servers (no-op on serverless cold-starts; skipped in tests).
if (process.env.NODE_ENV !== "test") {
  setInterval(() => publishDueScheduled(app.get("io")), 60 * 1000).unref?.();
}


// 404 Page
app.get("*", (req, res) => {
  res.status(404).render("404", {
    title: '404 - Page Not Found | Lumina',
    metaDescription: 'The page you are looking for does not exist or has been removed. Explore the homepage to find fresh perspectives and trending stories on Lumina!...',
    noIndex: true
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN" || (err.message && err.message.includes("invalid csrf token"))) {
    logger.warn(`⚠️ CSRF Token Error on ${req.method} ${req.originalUrl}`);
    return res.status(403).render("error", {
      message: "Session expired or invalid form token. Please refresh the page and try submitting again.",
      title: "Session Expired - Lumina",
      noIndex: true
    });
  }
  logger.error("🔥 Global Error:", err.stack);
  res.status(500).render("error", {
    message: "Something went wrong on our end. We are looking into it!",
    title: 'Error - Lumina',
    metaDescription: 'An error occurred while processing your request. We are looking into it! Return to the homepage to continue reading the latest innovative narratives!...',
    noIndex: true
  });
});

// Start Server (skipped under test — supertest binds its own ephemeral port)
if (process.env.NODE_ENV !== "test") {
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
}