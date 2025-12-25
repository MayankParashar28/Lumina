require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

if (!API_KEY) {
    console.error("❌ No API Key found in .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

const frameworks = [
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-pro",
    "gemini-1.0-pro",
    "gemini-2.0-flash-exp" // In case they have preview access
];

async function testModels() {
    console.log("🔍 Testing Gemini Models with provided API Key...\n");

    for (const modelName of frameworks) {
        process.stdout.write(`Testing model: ${modelName} ... `);
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent("Say 'OK'");
            const response = await result.response;
            const text = response.text();

            if (text) {
                console.log("✅ SUCCESS");
                console.log(`   (Response: ${text.trim()})`);
                console.log(`\n🎉 WORKING MODEL FOUND: ${modelName}\n`);
                return; // Stop after first success
            }
        } catch (error) {
            console.log("❌ FAILED");
            console.log(`   Error: ${error.message.split('[')[0].trim()}...` + (error.message.includes('404') ? ' (404 Not Found)' : ''));
        }
    }

    console.log("\n❌ No working models found. Please check your API Key and Google AI Studio project settings.");
}

testModels();
