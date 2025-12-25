const { Router } = require("express");
const router = Router();

router.get("/about", (req, res) => {
    res.render("about", {
        user: req.user,
        title: "About Lumina",
        path: "/about"
    });
});

router.get("/mission", (req, res) => {
    res.render("about", {
        user: req.user,
        title: "Our Mission - Lumina",
        path: "/mission"
    });
});

router.get("/privacy", (req, res) => {
    res.render("privacy", {
        user: req.user,
        title: "Privacy Policy - Lumina",
        path: "/privacy"
    });
});

router.get("/terms", (req, res) => {
    res.render("terms", {
        user: req.user,
        title: "Terms of Service - Lumina",
        path: "/terms"
    });
});

module.exports = router;
