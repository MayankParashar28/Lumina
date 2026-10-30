/**
 * Does this client want a JSON response rather than a redirect / HTML page?
 *
 * Several routes used to read `req.headers.accept.includes("json")` directly,
 * which threw a TypeError (surfacing as a 500) whenever the header was absent —
 * legal, and common for curl, server-to-server calls and some mobile clients.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function wantsJson(req) {
    if (!req) return false;
    if (req.xhr) return true;
    const accept = req.headers && req.headers.accept;
    return typeof accept === "string" && accept.includes("json");
}

module.exports = { wantsJson };
