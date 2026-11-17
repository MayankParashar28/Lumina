const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("../services/logger"); // Structured Logging

const GOOGLE_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const EMBEDDING_API_KEY = process.env.GOOGLE_EMBEDDING_API_KEY || GOOGLE_API_KEY;

// Embedding model. Configurable because Google retires embedding models:
// text-embedding-004 (used here before) was scheduled for shutdown, after which
// every call fails and new posts silently get no embedding. Vectors from
// different models are not comparable, so after changing this run
// `node scripts/generate-embeddings.js --stale` to re-embed existing posts.
const EMBEDDING_MODEL_ID = process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
// 768 keeps the vectors the same size as before, so the Atlas vector index
// (numDimensions: 768) keeps working.
const EMBEDDING_DIMS = Number(process.env.GOOGLE_EMBEDDING_DIMS) || 768;

const TEXT_MODEL_ID = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash";

const genAI = GOOGLE_API_KEY ? new GoogleGenerativeAI(GOOGLE_API_KEY) : null;
const embedAI = EMBEDDING_API_KEY ? new GoogleGenerativeAI(EMBEDDING_API_KEY) : null;

/**
 * Generates a vector embedding for the given text.
 * @param {string} text - The input text (title + body, or a search query).
 * @param {object} [opts]
 * @param {"RETRIEVAL_DOCUMENT"|"RETRIEVAL_QUERY"|"SEMANTIC_SIMILARITY"|"CLUSTERING"} [opts.taskType]
 *   Documents are embedded as RETRIEVAL_DOCUMENT and search queries as
 *   RETRIEVAL_QUERY, which is how the model is meant to be used for search.
 * @returns {Promise<number[]>} - An array of floating point numbers ([] on failure).
 */
async function generateEmbedding(text, { taskType = "RETRIEVAL_DOCUMENT" } = {}) {
    if (!embedAI) {
        logger.warn("⚠️ Google Embedding API Key missing. Skipping embedding generation.");
        return [];
    }

    if (!text || typeof text !== "string") return [];

    try {
        const model = embedAI.getGenerativeModel({ model: EMBEDDING_MODEL_ID });

        // Truncate text to avoid token limits. ~4 chars per token.
        const safeText = text.substring(0, 8000);

        const result = await model.embedContent({
            content: { role: "user", parts: [{ text: safeText }] },
            taskType,
            // Passed straight through to the REST API.
            outputDimensionality: EMBEDDING_DIMS,
        });
        const values = (result.embedding && result.embedding.values) || [];
        return values;
    } catch (error) {
        logger.error("❌ Error generating embedding (%s): %s", EMBEDDING_MODEL_ID, error.message);
        return [];
    }
}

/**
 * Ask Gemini for a JSON answer. Returns the parsed object, or null when AI is
 * not configured, the call fails, or the reply isn't valid JSON — callers
 * always have a non-AI fallback.
 */
async function generateJson(prompt, { timeoutMs = 15000, temperature = 0.2 } = {}) {
    if (!genAI) return null;
    try {
        const model = genAI.getGenerativeModel({
            model: TEXT_MODEL_ID,
            generationConfig: { responseMimeType: "application/json", temperature },
        });
        const call = model.generateContent(prompt);
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Gemini timed out after ${timeoutMs}ms`)), timeoutMs).unref?.()
        );
        const result = await Promise.race([call, timeout]);
        const raw = result.response.text().trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
        return JSON.parse(raw);
    } catch (error) {
        logger.warn("⚠️ Gemini JSON call failed: %s", error.message);
        return null;
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

module.exports = {
    generateEmbedding,
    generateJson,
    cosineSimilarity,
    EMBEDDING_MODEL_ID,
    EMBEDDING_DIMS,
    aiEnabled: () => !!genAI,
    embeddingsEnabled: () => !!embedAI,
};
