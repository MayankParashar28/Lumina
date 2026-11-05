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

module.exports = { generateEmbedding, cosineSimilarity };
