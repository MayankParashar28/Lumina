const { validateToken } = require("../services/authentication");
const User = require("../models/user");

function checkForAuthenticationCookie(cookieName) {
  return async (req, res, next) => {
    try {

      const tokenCookieValue = req.cookies[cookieName];

      if (!tokenCookieValue) {
        res.locals.user = null;
        return next();
      }

      const userPayload = validateToken(tokenCookieValue);

      if (!userPayload) {
        console.log("❌ Invalid token.");
        res.locals.user = null;
        return next();
      }

      const user = await User.findById(userPayload._id);
      if (!user) {
        res.locals.user = null;
        return next();
      }

      req.user = user;
      res.locals.user = user; // ✅ Set user for EJS
    } catch (error) {
      res.locals.user = null;
    }

    return next();
  };
}

module.exports = checkForAuthenticationCookie;