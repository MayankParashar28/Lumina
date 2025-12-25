function checkForAdmin(req, res, next) {
    if (!req.user) {
        return res.redirect("/user/signin");
    }
    if (req.user.role !== "ADMIN") {
        req.flash("error", "Access Denied: Admins only.");
        return res.redirect("/");
    }
    next();
}

module.exports = { checkForAdmin };
