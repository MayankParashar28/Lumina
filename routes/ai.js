// /routes/ai.js
const express = require("express");
const router = express.Router();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Blog = require("../models/blog"); // Import Blog model

const GOOGLE_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const GOOGLE_KEY_LIGHT = process.env.GOOGLE_GEMINI_KEY_LIGHT; // Secondary Key

const GEMINI_MODEL_ID = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash";

if (!GOOGLE_API_KEY) {
  console.warn("⚠️  GOOGLE_GEMINI_API_KEY is not set. AI blog generation will fail until this is provided.");
}

const genAI = GOOGLE_API_KEY ? new GoogleGenerativeAI(GOOGLE_API_KEY) : null;
const genAILight = GOOGLE_KEY_LIGHT ? new GoogleGenerativeAI(GOOGLE_KEY_LIGHT) : (genAI || null); // Fallback to main if missing

// Per-user, per-feature limits.
//
// This used to be one 60-second cooldown shared by every AI button, stored on
// the user document: suggest titles, then press "Continue writing", and you
// were told to wait 58 seconds. Each feature now has its own allowance per
// minute, so using one doesn't lock out the others. Admins are exempt.
const rateLimit = require("express-rate-limit");
const { makeRateLimitStore } = require("../services/redis");

const requireUser = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Please sign in to use AI." });
  next();
};

const perUser = (max, prefix) => [
  requireUser,
  rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.user.role === "ADMIN",
    keyGenerator: (req) => String(req.user._id),
    store: makeRateLimitStore(prefix),
    handler: (req, res) =>
      res.status(429).json({ error: "That's a lot of AI in one minute. Give it a moment and try again." }),
  }),
];

// Models sometimes wrap their answer in a ```html or ```json fence despite
// being told not to.
const stripFences = (text) =>
  String(text || "")
    .replace(/^\s*```[a-z]*\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

// AI helpers unlock after a verified email and a first post (they cost real
// money per call, so throwaway accounts shouldn't be able to burn them).
const { requireFeature } = require("../services/unlocks");
const aiUnlocked = requireFeature("ai");

router.post("/generate-blog", aiUnlocked, perUser(4, "rl:ai-blog:"), async (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 300);
  // The story so far, as plain text. "Continue writing" sends it so the AI
  // carries on from where the writer stopped instead of starting over.
  const story = String(req.body.body || "").trim().slice(-6000);
  const tone = String(req.body.tone || "Professional").slice(0, 40);

  if (!title && !story) {
    return res.status(400).json({ error: "Add a title or a first paragraph before asking the AI to write." });
  }
  if (!genAI) {
    return res.status(503).json({ error: "AI writing isn't set up on this server yet." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });

    const format = [
      "Formatting:",
      "- Return only HTML: <p> for every paragraph, <h2>/<h3> for headings, <ul>/<ol> with <li> for lists.",
      "- Short paragraphs (3-4 sentences at most).",
      "- No Markdown, no code fences, no <html>/<body> wrapper.",
    ].join("\n");

    const prompt = story
      ? [
          "You are helping a writer continue their blog post. Write the next part of it.",
          `Tone: ${tone}.`,
          "- Continue directly from where the text stops; do not repeat or summarise what is already written.",
          "- Match the writer's voice, tense and point of view.",
          "- Write 2 to 4 paragraphs. Add a heading only if the post already uses them and a new section clearly starts.",
          "- Do not add a conclusion unless the post is clearly wrapping up.",
          format,
          title ? `Title: "${title}"` : "",
          "The post so far:",
          '"""',
          story,
          '"""',
        ].filter(Boolean).join("\n")
      : [
          "You are a professional blogger. Write a complete, publish-ready blog post.",
          `Tone: ${tone}.`,
          format,
          `Title: "${title}". Do not repeat the title at the top; start with the introduction.`,
        ].join("\n");

    const result = await model.generateContent(prompt);
    const aiText = stripFences(result?.response?.text());

    if (!aiText) {
      return res.status(502).json({ error: "The AI didn't write anything this time. Try again." });
    }

    res.json({ content: aiText, continued: Boolean(story) });
  } catch (err) {
    console.error("❌ Gemini API Error:", err instanceof Error ? err.message : err);
    const status = err?.status === 429 ? 429 : 502;
    res.status(status).json({
      error: status === 429 ? "The AI is at its limit right now. Try again in a minute." : "The AI couldn't write that. Try again.",
    });
  }
});

router.post("/generate-tags", aiUnlocked, perUser(6, "rl:ai-tags:"), async (req, res) => {
  const { title, body } = req.body;



  if (!title) {
    return res.status(400).json({ error: "Title is required for tag generation." });
  }

  if (!genAILight) {
    return res.status(500).json({ error: "AI service not configured." });
  }

  try {
    const model = genAILight.getGenerativeModel({ model: GEMINI_MODEL_ID });
    const prompt = `Generate exactly 4 or 5 relevant, comma-separated tags for a blog post titled "${title}"${body ? ` with this content: "${body.substring(0, 500)}..."` : ""}. Return ONLY the tags, no other text. Example: "Tech, AI, Future, Innovation, Coding"`;

    const result = await model.generateContent(prompt);
    const aiText = result.response.text().trim();

    res.json({ tags: aiText });
  } catch (err) {
    console.error("❌ Gemini Tag Error:", err);
    res.status(500).json({ error: "Failed to generate tags." });
  }
});

// Generate Smart Titles
router.post("/generate-title", aiUnlocked, perUser(6, "rl:ai-title:"), async (req, res) => {
  const body = String(req.body.body || "").trim();
  const tone = String(req.body.tone || "Professional").slice(0, 40);

  if (body.length < 50) {
    return res.status(400).json({ error: "Write a few sentences first, then ask for titles." });
  }
  if (!genAI) {
    return res.status(503).json({ error: "AI titles aren't set up on this server yet." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });

    const prompt = [
      "You are a blog editor. Suggest 5 titles for the post below.",
      `Tone: ${tone}`,
      "Requirements:",
      "- Each under 60 characters, specific to this post, no clickbait.",
      "- Return ONLY a JSON array of 5 strings. No other text.",
      "The post:",
      body.slice(0, 2000),
    ].join("\n");

    const result = await model.generateContent(prompt);
    const text = stripFences(result.response.text());

    // Take the array even if the model added words around it.
    let titles = [];
    const match = text.match(/\[[\s\S]*\]/);
    try {
      titles = JSON.parse(match ? match[0] : text);
    } catch (e) {
      titles = text.split("\n").map((l) => l.replace(/^\s*(?:[-*\d.)]+\s*)?["']?|["',]?\s*$/g, ""));
    }
    titles = (Array.isArray(titles) ? titles : [])
      .map((t) => String(t).trim())
      .filter((t) => t && t.length <= 120)
      .slice(0, 5);

    if (!titles.length) {
      return res.status(502).json({ error: "No titles came back. Try again." });
    }
    return res.json({ titles });
  } catch (error) {
    console.error("AI Title Error:", error);
    const status = error.status === 429 ? 429 : 502;
    const message = status === 429 ? "The AI is at its limit right now. Try again in a minute." : "Couldn't come up with titles. Try again.";
    return res.status(status).json({ error: message });
  }
});

const AiSuggestion = require("../models/aiSuggestion"); // Import Cache Model

// Generate AI Comment Suggestions
router.post("/generate-comment-suggestions", perUser(10, "rl:ai-comments:"), async (req, res) => {
  const { blogId } = req.body;

  if (!blogId) {
    return res.status(400).json({ error: "Blog ID is required." });
  }

  try {
    // 🛡️ Handle Preview Mode (No DB ID)
    if (blogId === "preview-id") {
      return res.json({ suggestions: ["Preview Comment 1", "Preview Comment 2", "Preview Comment 3"] });
    }

    // 1️⃣ CACHE CHECK: Do we have fresh suggestions?
    const cached = await AiSuggestion.findOne({ blogId });
    if (cached) {

      return res.json({ suggestions: cached.suggestions });
    }

    // 2️⃣ CACHE MISS: Generate new ones
    const blog = await Blog.findById(blogId);
    if (!blog) {
      return res.status(404).json({ error: "Blog not found." });
    }

    if (!genAI) {
      return res.json({ suggestions: ["Great read! 👏", "Thanks for sharing.", "Interesting perspective."] });
    }
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });

    const prompt = `
      You are a helpful blog assistant. 
      Read the following blog post title and content, then generate exactly 3 short, distinct comment suggestions.
      
      Viewpoints to cover:
      1. Positive / Agreement.
      2. Thought-provoking Question.
      3. Constructive / Alternative Perspective.
      
      Blog Title: "${blog.title}"
      Blog Content (Excerpt): "${blog.body ? blog.body.substring(0, 1000).replace(/<[^>]*>/g, '') : ''}..."

      Requirements:
      - Return ONLY a raw JSON array of strings.
      - Keep them under 10 words each.
      - No intro/outro text. Just the array.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();

    // Clean up potential markdown formatting
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    let suggestions = [];
    try {
      suggestions = JSON.parse(text);
    } catch (e) {
      console.error("Failed to parse AI response:", text);
    }

    if (!suggestions || suggestions.length === 0) {
      const defaults = ["Great read! 👏", "Thanks for sharing.", "Interesting perspective."];
      return res.json({ suggestions: defaults });
    }

    // 3️⃣ SAVE TO CACHE (Valid for 24h)
    await AiSuggestion.create({
      blogId: blog._id,
      suggestions: suggestions
    });


    return res.json({ suggestions });
  } catch (error) {
    console.error("AI Comment Suggestions Error:", error);
    // Fallback
    return res.json({ suggestions: ["Great read! 👏", "Thanks for sharing.", "Interesting perspective."] });
  }
});

module.exports = router;