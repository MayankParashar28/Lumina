
const mongoose = require("mongoose");
const User = require("../models/user");
require("dotenv").config();

const email = process.argv[2];

if (!email) {
    console.error("❌ Please provide an email address.");
    console.log("Usage: node scripts/make_admin.js <email>");
    process.exit(1);
}

mongoose.connect(process.env.MONGODB_URL)
    .then(async () => {
        console.log("✅ Connected to MongoDB");
        const user = await User.findOne({ email: email });

        if (!user) {
            console.error(`❌ User with email ${email} not found.`);
            process.exit(1);
        }

        user.role = "ADMIN";
        await user.save();
        console.log(`✅ Success! ${user.fullName} (${user.email}) is now an ADMIN.`);
        process.exit(0);
    })
    .catch((err) => {
        console.error("❌ Database Error:", err);
        process.exit(1);
    });
