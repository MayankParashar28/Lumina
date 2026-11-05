const { Router } = require("express");
const Blog = require("../models/blog");
const logger = require("../services/logger"); // Structured Logging
const router = Router();

// 📡 RSS feed.
//
// The one way to follow this site that does not require an account here, does
// not go through anybody's algorithm, and keeps working if the site is quiet
// for a month. Readers' apps poll it; so do Feedly, Inoreader and a number of
// aggregators that will not index a site without one.
//
// Deliberately the 20 most recent posts with summaries rather than full bodies:
// a feed is an index, and the point is to bring the reader back here.
const FEED_LIMIT = 20;

// XML has no tolerance for a stray & or < in a title, and a post title is
// whatever the author typed.
const xmlEscape = (v) =>
    String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

router.get("/rss.xml", async (req, res) => {
    try {
        const baseUrl = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`)
            .replace(/\/+$/, "");

        const blogs = await Blog.find({ status: "published" })
            .sort({ createdAt: -1 })
            .limit(FEED_LIMIT)
            .select("title slug body metaDescription createdAt category")
            .populate("createdBy", "fullName")
            .lean();

        const items = blogs
            .map((blog) => {
                const url = `${baseUrl}/blog/${blog.slug || blog._id}`;
                const plain = String(blog.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
                const summary = blog.metaDescription || (plain.length > 280 ? `${plain.slice(0, 280)}\u2026` : plain);
                const author = blog.createdBy ? blog.createdBy.fullName : "Lumina";
                return `
    <item>
        <title>${xmlEscape(blog.title)}</title>
        <link>${xmlEscape(url)}</link>
        <guid isPermaLink="true">${xmlEscape(url)}</guid>
        <pubDate>${new Date(blog.createdAt).toUTCString()}</pubDate>
        <dc:creator>${xmlEscape(author)}</dc:creator>${blog.category ? `
        <category>${xmlEscape(blog.category)}</category>` : ""}
        <description>${xmlEscape(summary)}</description>
    </item>`;
            })
            .join("");

        const updated = blogs.length ? new Date(blogs[0].createdAt) : new Date();

        res.header("Content-Type", "application/rss+xml; charset=utf-8");
        // Readers poll on their own schedule; a few minutes of staleness is
        // invisible to them and saves re-rendering this for every poller.
        res.header("Cache-Control", "public, max-age=600");
        return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
    <title>Lumina</title>
    <link>${xmlEscape(baseUrl)}/</link>
    <description>Writing from the people building things.</description>
    <language>en</language>
    <lastBuildDate>${updated.toUTCString()}</lastBuildDate>
    <atom:link href="${xmlEscape(baseUrl)}/rss.xml" rel="self" type="application/rss+xml" />${items}
</channel>
</rss>`);
    } catch (err) {
        logger.error("RSS Generation Error:", err);
        return res.status(500).end();
    }
});

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
