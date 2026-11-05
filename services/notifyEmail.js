// One way to send an engagement email, used by the comment, reply and follow
// routes.
//
// Every one of them has the same five obligations — look the recipient up, skip
// them if they are unverified or have opted out, build their unsubscribe link,
// send, and never let a mail failure affect the thing the user was actually
// doing. Doing that inline at each call site is how the three copies of the
// publish fan-out happened, so it lives here once.
const logger = require("./logger");
const { linkFor, KINDS } = require("../utils/unsubscribe");

function baseUrl() {
  return (
    process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000"
  ).replace(/\/+$/, "");
}

/**
 * Sends one engagement email, if the recipient should get it.
 *
 * Never rejects: the caller is in the middle of saving a comment or a follow
 * and the mail is the least important thing happening.
 *
 * @param {object}   opts
 * @param {string}   opts.kind        a key of KINDS ("comment", "follow", ...)
 * @param {object}   opts.recipientId who to mail
 * @param {object}   [opts.senderId]  who caused it; never mailed about their own action
 * @param {Function} opts.build       (unsubscribeUrl) => arguments for the send function
 * @param {Function} opts.send        (email, payload) => Promise
 */
async function notifyByEmail({ kind, recipientId, senderId, build, send }) {
  try {
    const field = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
    if (!field) throw new Error(`unknown notification kind: ${kind}`);

    // Nobody needs an email about something they did themselves. Checked here
    // as well as at the call sites, because this is the cheap place to be sure.
    if (senderId && String(senderId) === String(recipientId)) return false;

    const User = require("../models/user");
    // The preference filter is part of the query: a recipient who has opted out
    // is simply not found, so there is no path where we load them and forget to
    // check. isVerified matters because an unverified address was never
    // confirmed to belong to the person who typed it.
    const recipient = await User.findOne({
      _id: recipientId,
      isVerified: true,
      email: { $exists: true, $ne: "" },
      [field]: { $ne: false },
    })
      .select("_id email")
      .lean();

    if (!recipient) return false;

    await send(recipient.email, build(linkFor(recipient._id, kind, baseUrl())));
    return true;
  } catch (err) {
    logger.error("⚠️ %s email failed: %s", kind, err.message);
    return false;
  }
}

module.exports = { notifyByEmail, baseUrl };
