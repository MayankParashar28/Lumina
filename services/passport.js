const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../models/user");
const crypto = require("crypto");

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: "/user/auth/google/callback",
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                // 1. Check if user already exists with this email
                let user = await User.findOne({ email: profile.emails[0].value });

                if (user) {
                    // User exists, log them in
                    return done(null, user);
                } else {
                    // 2. If not, create a new user
                    // Generate a random password since they verify via Google
                    const randomPassword = crypto.randomBytes(16).toString("hex");

                    user = await User.create({
                        fullName: profile.displayName,
                        email: profile.emails[0].value,
                        password: randomPassword,
                        profilePic: profile.photos[0].value,
                        isVerified: true, // Trusted provider
                        role: "USER"
                    });

                    return done(null, user);
                }
            } catch (err) {
                return done(err, null);
            }
        }
    )
);

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
