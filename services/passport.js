const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../models/user");
const crypto = require("crypto");
const logger = require("./logger");

// Google sign-in is optional. Registering the strategy with an undefined clientID
// throws at require time ("OAuth2Strategy requires a clientID option"), which took
// the whole app down on boot — so only register it when it's actually configured.
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const verifyGoogleLogin = async (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        if (!email) {
            return done(new Error("No email found in Google profile"), null);
        }

        // 1. Check if user already exists with this email
        let user = await User.findOne({ email });

        if (user) {
            // User exists, log them in
            return done(null, user);
        }

        // 2. If not, create a new user.
        // Generate a random password since they verify via Google.
        const randomPassword = crypto.randomBytes(16).toString("hex");
        const profilePic = (profile.photos && profile.photos[0] && profile.photos[0].value)
            ? profile.photos[0].value
            : "/images/default-avatar.png";

        user = await User.create({
            fullName: profile.displayName || "Google User",
            email,
            password: randomPassword,
            profilePic,
            isVerified: true, // Trusted provider
            role: "USER"
        });

        return done(null, user);
    } catch (err) {
        return done(err, null);
    }
};

if (googleEnabled) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: process.env.GOOGLE_CALLBACK_URL || "/user/auth/google/callback",
                proxy: true,
            },
            verifyGoogleLogin
        )
    );
} else {
    logger.warn("⚠️ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is disabled.");
}

// Serialize user into the sessions
passport.serializeUser((user, done) => {
    done(null, user._id);
});

// Deserialize user from the sessions
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

module.exports = { googleEnabled };
