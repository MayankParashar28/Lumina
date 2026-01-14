const Filter = require("bad-words");
const filter = new Filter();

// Default bad-words list might be missing some common terms depending on the version
// We explicitly add them to be safe.
filter.addWords("bullshit", "dumbass", "fucker", "idiot", "stupid");

const { GoogleGenerativeAI } = require("@google/generative-ai");

// Setup AI Access (Reusing the Light Key for efficiency)
const GOOGLE_KEY_LIGHT = process.env.GOOGLE_GEMINI_KEY_LIGHT;
const GOOGLE_KEY_MAIN = process.env.GOOGLE_GEMINI_API_KEY;

// Fallback logic matches routes/ai.js
const apiKey = GOOGLE_KEY_LIGHT || GOOGLE_KEY_MAIN;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const MODEL_ID = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash";

/**
 * Moderate content using a hybrid approach:
 * 1. Local "bad-words" filter (Fast & Cheap)
 * 2. Gemini AI Analysis (Smart & Contextual)
 * 
 * @param {string} text - The content to moderate.
 * @returns {Promise<{safe: boolean, reason?: string}>}
 */
async function moderateContent(text) {
    if (!text || !text.trim()) return { safe: true };

    // 1️⃣ LEVEL 1: Local Keyword Filter
    // Strip HTML tags AND collapse multiple spaces to ensure clean matching
    // Replace tags with space to prevent "good<b>bad</b>" becoming "goodbad"
    const plainText = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

    if (filter.isProfane(plainText)) {
        // Find the specific word for better feedback
        const cleaned = filter.clean(plainText);
        const words = plainText.split(/\s+/);
        const cleanedWords = cleaned.split(/\s+/);
        let flaggedWord = "Profanity";

        for (let i = 0; i < words.length; i++) {
            if (words[i] !== cleanedWords[i]) {
                flaggedWord = words[i];
                break;
            }
        }

        return {
            safe: false,
            reason: `Contains profane word: "${flaggedWord}" (Local Filter)`
        };
    }

    // 2️⃣ LEVEL 2: AI Context Analysis (If AI is configured)
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: MODEL_ID });

            // STRICT Prompt for Safety Analysis
            const prompt = `
            Analyze the following text for safety violations.
            Categories to check: 
            - Hate Speech
            - Harassment
            - Sexual Content
            - Dangerous Content / Violence
            - Toxicity

            Text: "${text.substring(0, 1000)}"

            Respond with ONLY a JSON object:
            {
                "safe": boolean,
                "reason": "Short explanation if unsafe, otherwise null"
            }
            `;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            let aiText = response.text().trim();

            // Clean up code blocks if present
            aiText = aiText.replace(/```json/g, "").replace(/```/g, "").trim();

            const analysis = JSON.parse(aiText);

            if (!analysis.safe) {
                return {
                    safe: false,
                    reason: analysis.reason || "Content flagged as unsafe by AI."
                };
            }

        } catch (error) {
            console.error("⚠️ AI Moderation Error:", error.message);
            // Fail open (allow) if AI is down, or Fail closed (block)?
            // Defaulting to "Allow" to prevent user frustration during API outages,
            // relying on local filter as backup.
            return { safe: true };
        }
    }

    return { safe: true };
}

module.exports = moderateContent;
