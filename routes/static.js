const { Router } = require("express");
const Blog = require("../models/blog");
const router = Router();

// Sitemap.xml Generation
router.get("/sitemap.xml", async (req, res) => {
    try {
        const blogs = await Blog.find({ status: "published" }).select("_id updatedAt");
        const baseUrl = "https://lumina.blog";

        let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${baseUrl}/</loc>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>
    <url>
        <loc>${baseUrl}/about</loc>
        <changefreq>monthly</changefreq>
        <priority>0.5</priority>
    </url>
    <url>
        <loc>${baseUrl}/privacy</loc>
        <changefreq>yearly</changefreq>
        <priority>0.3</priority>
    </url>
    <url>
        <loc>${baseUrl}/terms</loc>
        <changefreq>yearly</changefreq>
        <priority>0.3</priority>
    </url>`;

        blogs.forEach(blog => {
            sitemap += `
    <url>
        <loc>${baseUrl}/blog/${blog._id}</loc>
        <lastmod>${new Date(blog.updatedAt).toISOString()}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
        });

        sitemap += `
</urlset>`;

        res.header("Content-Type", "application/xml");
        res.send(sitemap);
    } catch (err) {
        console.error("Sitemap Generation Error:", err);
        res.status(500).end();
    }
});

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
