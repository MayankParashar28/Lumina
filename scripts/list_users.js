
const mongoose = require("mongoose");
const User = require("../models/user");
require("dotenv").config();

mongoose.connect(process.env.MONGODB_URL)
    .then(async () => {
        console.log("✅ Connected to MongoDB");
        const users = await User.find({}, "fullName email role");

        if (users.length === 0) {
            console.log("⚠️ No users found in database.");
        } else {
            console.log("\n👥 Current Users & Roles:");
            users.forEach(u => {
                console.log(` - ${u.fullName} (${u.email}) [${u.role}]`);
            });
        }
        process.exit(0);
    })
    .catch((err) => {
        console.error("❌ Database Error:", err);
        process.exit(1);
    });
