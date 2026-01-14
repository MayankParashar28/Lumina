// /routes/ai.js
const express = require("express");
const router = express.Router();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const User = require("../models/user"); // Import User model
const Blog = require("../models/blog"); // Import Blog model

const GOOGLE_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const GOOGLE_KEY_LIGHT = process.env.GOOGLE_GEMINI_KEY_LIGHT; // Secondary Key

const GEMINI_MODEL_ID = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash";

if (!GOOGLE_API_KEY) {
  console.warn("⚠️  GOOGLE_GEMINI_API_KEY is not set. AI blog generation will fail until this is provided.");
}

const genAI = GOOGLE_API_KEY ? new GoogleGenerativeAI(GOOGLE_API_KEY) : null;
const genAILight = GOOGLE_KEY_LIGHT ? new GoogleGenerativeAI(GOOGLE_KEY_LIGHT) : (genAI || null); // Fallback to main if missing

// Middleware to Check AI Rate Limit
const rateLimitAI = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }

  // Exempt Admins
  if (req.user.role === "ADMIN") return next();

  try {
    const user = await User.findById(req.user._id);
    const AI_COOLDOWN = 60 * 1000; // 1 Minute Cooldown

    if (user.lastAiRequest) {
      const timeSinceLast = Date.now() - new Date(user.lastAiRequest).getTime();
      if (timeSinceLast < AI_COOLDOWN) {
        const remaining = Math.ceil((AI_COOLDOWN - timeSinceLast) / 1000);
        return res.status(429).json({ error: `Please wait ${remaining} seconds before using AI again.` });
      }
    }

    // Update timestamp
    user.lastAiRequest = new Date();
    await user.save();
    next();
  } catch (err) {
    console.error("Rate Limit Error:", err);
    res.status(500).json({ error: "Server Error during rate limit check." });
  }
};

router.post("/generate-blog", rateLimitAI, async (req, res) => {
  const { title, tone } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Please provide a blog title before generating content." });
  }
  if (!genAI) {
    return res.status(500).json({ error: "AI service not configured. Please add your Gemini API key." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });

    // customizable tone logic
    const selectedTone = tone || "Professional";
    const toneInstruction = `Tone: ${selectedTone}.`;

    const prompt = [
      "You are a professional blogger. Craft a complete, publish-ready blog post.",
      toneInstruction,
      "Requirements:",
      "- Return purely valid HTML structure.",
      "- usage of <br> tags is allowed for line breaks.",
      "- Break text into short, readable paragraphs (max 3-4 sentences each).",
      "- Wrap EVERY paragraph in <p> tags.",
      "- Use <h2> for main sections and <h3> for subsections.",
      "- Use <ul> and <li> for lists.",
      "- Do NOT use Markdown (no **, ##). Do NOT wrap in ```html``` blocks.",
      "- Ensure there is vertical spacing between sections."
    ].join("\n");

    const userPrompt = `Blog title: "${title.trim()}". Write the full blog content now. Do NOT repeat the title at the top. Start directly with the introduction.`;

    const result = await model.generateContent([
      { text: prompt },
      { text: userPrompt }
    ]);

    const aiText = result?.response?.text()?.trim();

    if (!aiText) {
      return res.status(502).json({ error: "AI did not return any content. Please try again." });
    }

    res.json({ content: aiText });
  } catch (err) {
    console.error("❌ Gemini API Error:", err instanceof Error ? err.message : err);
    const apiMessage = err?.response?.error?.message || err?.message || "AI generation failed.";
    res.status(500).json({ error: apiMessage });
  }
});

router.post("/generate-tags", rateLimitAI, async (req, res) => {
  const { title, body } = req.body;
  console.log("🤖 AI Tags Requested for Title:", title); // Debug log


  if (!title) {
    return res.status(400).json({ error: "Title is required for tag generation." });
  }

  if (!genAILight) {
    return res.status(500).json({ error: "AI service not configured." });
  }

  try {
    const model = genAILight.getGenerativeModel({ model: GEMINI_MODEL_ID });
    const prompt = `Generate 5 relevant, comma-separated tags for a blog post titled "${title}"${body ? ` with this content: "${body.substring(0, 500)}..."` : ""}. Return ONLY the tags, no other text. Example: "Tech, AI, Future, Innovation, Coding"`;

    const result = await model.generateContent(prompt);
    const aiText = result.response.text().trim();

    res.json({ tags: aiText });
  } catch (err) {
    console.error("❌ Gemini Tag Error:", err);
    res.status(500).json({ error: "Failed to generate tags." });
  }
});

// Generate Smart Titles
router.post("/generate-title", rateLimitAI, async (req, res) => {
  const { body, tone } = req.body;

  if (!body) {
    return res.status(400).json({ error: "Story content is required for context." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });

    const prompt = [
      "You are a viral blog editor. Generate 5 catchy, engaging blog titles based on the content below.",
      `Context: ${body.substring(0, 1000)}...`, // Limit context
      `Tone: ${tone || 'Professional'}`,
      "Requirements:",
      "- Return ONLY a raw JSON array of strings",
      "- Titles should be short (under 60 chars)",
      "- No intro/outro text. Just the JSON array."
    ].join("\n");

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();

    // Clean up markdown code blocks if present
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    const titles = JSON.parse(text);

    return res.json({ titles });
  } catch (error) {
    console.error("AI Title Error:", error);
    const status = error.status === 429 ? 429 : 500;
    const message = error.status === 429 ? "AI Quota Exceeded. Please wait a minute." : "Failed to generate titles.";
    return res.status(status).json({ error: message });
  }
});

const AiSuggestion = require("../models/aiSuggestion"); // Import Cache Model

// Generate AI Comment Suggestions
router.post("/generate-comment-suggestions", rateLimitAI, async (req, res) => {
  const { blogId } = req.body;

  if (!blogId) {
    return res.status(400).json({ error: "Blog ID is required." });
  }

  try {
    // 1️⃣ CACHE CHECK: Do we have fresh suggestions?
    const cached = await AiSuggestion.findOne({ blogId });
    if (cached) {
      console.log("⚡ Serving valid 24h Cache for:", blogId);
      return res.json({ suggestions: cached.suggestions });
    }

    // 2️⃣ CACHE MISS: Generate new ones
    const blog = await Blog.findById(blogId);
    if (!blog) {
      return res.status(404).json({ error: "Blog not found." });
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
    console.log("💾 Saved new AI suggestions to 24h cache.");

    return res.json({ suggestions });
  } catch (error) {
    console.error("AI Comment Suggestions Error:", error);
    // Fallback
    return res.json({ suggestions: ["Great read! 👏", "Thanks for sharing.", "Interesting perspective."] });
  }
});

module.exports = router;