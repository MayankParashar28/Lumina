const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("../services/logger"); // Structured Logging

const GOOGLE_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const EMBEDDING_API_KEY = process.env.GOOGLE_EMBEDDING_API_KEY || GOOGLE_API_KEY;

// Use text-embedding-004 (SoTA) instead of legacy embedding-001
const EMBEDDING_MODEL_ID = "text-embedding-004";

const genAI = GOOGLE_API_KEY ? new GoogleGenerativeAI(GOOGLE_API_KEY) : null;
const embedAI = EMBEDDING_API_KEY ? new GoogleGenerativeAI(EMBEDDING_API_KEY) : null;

/**
 * Generates a vector embedding for the given text.
 * @param {string} text - The input text (title + body).
 * @returns {Promise<number[]>} - An array of floating point numbers.
 */
async function generateEmbedding(text) {
    if (!embedAI) {
        logger.warn("⚠️ Google Embedding API Key missing. Skipping embedding generation.");
        return [];
    }

    if (!text || typeof text !== "string") return [];

    try {
        const model = embedAI.getGenerativeModel({ model: EMBEDDING_MODEL_ID });

        // Truncate text to avoid token limits (max 2048 tokens usually)
        // A rough estimate: 1 token ~= 4 chars, so limit to 8000 chars safely.
        const safeText = text.substring(0, 8000);

        const result = await model.embedContent(safeText);
        const embedding = result.embedding;

        return embedding.values;
    } catch (error) {
        logger.error("❌ Error generating embedding:", error.message);
        return [];
    }
}

/**
 * Calculates Cosine Similarity between two vectors.
 * Returns a value between -1 (opposite) and 1 (identical).
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] ** 2;
        normB += vecB[i] ** 2;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generates a short summary and bullet point highlights for the given text.
 * @param {string} text - The blog content.
 * @returns {Promise<{summary: string, highlights: string[]}>}
 */
async function generateSummary(text) {
    if (!genAI) return { summary: "AI service unavailable.", highlights: [] };

    const modelsToTry = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-pro-latest"];
    let lastError = null;

    for (const modelId of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelId });
            const prompt = `Summarize the following blog post in 2-3 sentences. Also, extract 3-5 key highlights as brief bullet points. 
            Return the result in JSON format: {"summary": "...", "highlights": ["...", "..."]}.
            
            Content: ${text.substring(0, 5000)}`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const textResponse = response.text();

            const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON found");

            return JSON.parse(jsonMatch[0].trim());
        } catch (error) {
            logger.error(`❌ Model ${modelId} failed:`, error.message);
            lastError = error;
        }
    }

    return {
        summary: text.substring(0, 150) + "...",
        highlights: ["Could not generate AI highlights at this time. Please check your API quota or model availability."]
    };
}

/**
 * Generates the strongest good-faith counter-argument ("steelman") to a post.
 * @param {string} title
 * @param {string} text - plain-text blog body
 * @returns {Promise<string>} the counterpoint text (HTML-free)
 */
async function generateCounterpoint(title, text) {
    if (!genAI) return "AI service unavailable.";

    const modelsToTry = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-pro-latest"];
    for (const modelId of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelId });
            const prompt = [
                "You are a sharp, fair-minded critic. Read the blog post below and write the STRONGEST,",
                "good-faith opposing view — what a thoughtful, well-informed skeptic would argue.",
                "Steelman the other side; do not strawman. Be respectful and specific.",
                "Return 2-4 short paragraphs of plain text. No markdown, no headers, no preamble.",
                "",
                `Title: ${title}`,
                `Post: ${String(text).substring(0, 5000)}`,
            ].join("\n");

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const out = (response.text() || "").trim();
            if (out) return out;
        } catch (error) {
            logger.error(`❌ Counterpoint model ${modelId} failed:`, error.message);
        }
    }
    return "Could not generate a counterpoint right now. Please try again later.";
}

/**
 * Rewrites a post at a given reading level.
 * @param {string} level - "eli5" | "expert"
 * @param {string} title
 * @param {string} text - plain-text blog body
 * @returns {Promise<string>} rewritten text (plain text)
 */
async function rewriteAtLevel(level, title, text) {
    if (!genAI) return "AI service unavailable.";

    const instructions = {
        eli5: "Rewrite the post so a curious 12-year-old can understand it. Use simple words, short sentences, and everyday analogies. Keep all the key ideas.",
        expert: "Rewrite the post for a domain expert. Be precise and technical, use correct terminology, and go deeper where the original was shallow. Keep it concise.",
    };
    const instruction = instructions[level] || instructions.eli5;

    const modelsToTry = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-pro-latest"];
    for (const modelId of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelId });
            const prompt = [
                instruction,
                "Return plain text only (short paragraphs). No markdown, no headers, no preamble.",
                "",
                `Title: ${title}`,
                `Post: ${String(text).substring(0, 6000)}`,
            ].join("\n");

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const out = (response.text() || "").trim();
            if (out) return out;
        } catch (error) {
            logger.error(`❌ Rewrite (${level}) model ${modelId} failed:`, error.message);
        }
    }
    return "Could not rewrite this post right now. Please try again later.";
}

module.exports = { generateEmbedding, cosineSimilarity, generateSummary, generateCounterpoint, rewriteAtLevel };
