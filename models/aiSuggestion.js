const mongoose = require("mongoose");

const aiSuggestionSchema = new mongoose.Schema(
    {
        blogId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "blog",
            required: true,
            unique: true, // One cache entry per blog
        },
        suggestions: {
            type: [String],
            required: true,
        },
        // TTL Index: This document will automatically self-destruct after 24 hours
        createdAt: {
            type: Date,
            default: Date.now,
            expires: 86400, // 24 Hours in seconds
        },
    },
    { timestamps: true }
);

const AiSuggestion = mongoose.model("aiSuggestion", aiSuggestionSchema);

module.exports = AiSuggestion;
