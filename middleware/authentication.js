const { validateToken } = require("../services/authentication");
const User = require("../models/user");
const logger = require("../services/logger");

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
        // Routine: an expired or tampered cookie. Treat as anonymous.
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
      // Swallowing this silently hid real failures (a dropped Mongo connection
      // looked identical to a signed-out visitor). Degrade to anonymous, but say so.
      logger.error("Auth cookie check failed; treating request as anonymous:", error);
      res.locals.user = null;
    }

    return next();
  };
}

module.exports = checkForAuthenticationCookie;