const User = require("../models/user");

// Check if a user has an active subscription
async function checkSubscription(userId) {
    const user = await User.findById(userId);
    return user && user.isSubscribed; // Returns true if subscribed
}

module.exports = { checkSubscription };