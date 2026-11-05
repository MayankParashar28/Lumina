const { Router } = require("express");
const Blog = require("../models/blog");
const logger = require("../services/logger"); // Structured Logging
const router = Router();

// Sitemap.xml Generation
router.get("/sitemap.xml", async (req, res) => {
    try {
        const blogs = await Blog.find({ status: "published" }).select("_id slug updatedAt");
        // Was hardcoded to the old Vercel domain, so the sitemap advertised URLs on
        // a host this deployment may not even serve. Follow the configured origin.
        const baseUrl = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`)
            .replace(/\/+$/, "");

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

        // The canonical URL is the slug. Listing the ObjectId form instead would
        // fill the sitemap with URLs that answer 301, which wastes a crawler's
        // budget and asks it to discover the real URL one redirect at a time.
        // `|| blog._id` covers any post that predates slugs and has not been
        // through scripts/backfill-slugs.js yet.
        blogs.forEach(blog => {
            sitemap += `
    <url>
        <loc>${baseUrl}/blog/${blog.slug || blog._id}</loc>
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
        logger.error("Sitemap Generation Error:", err);
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
