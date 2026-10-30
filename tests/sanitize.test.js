// Server-side sanitisation of post bodies.
//
// views/blog.ejs sanitises with DOMPurify in the browser, but a client that
// POSTs straight to the create/edit endpoints never runs that code. These tests
// drive those endpoints directly — no editor, no browser — and assert the
// stored document is clean.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");
const { sanitizePostBody, stripTags } = require("../utils/sanitize");

let ctx, author, cookie;

// Long enough to clear the 50-word minimum that the publish and edit paths enforce.
const FILLER = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

const XSS = `<script>alert('pwned')</script>` +
    `<img src="x" onerror="alert('pwned')">` +
    `<a href="javascript:alert('pwned')">click</a>` +
    `<iframe src="https://evil.example"></iframe>` +
    `<p onclick="alert('pwned')">text</p>`;

function assertClean(body, where) {
    assert.ok(!/<script/i.test(body), `${where}: a <script> tag survived — ${body}`);
    assert.ok(!/onerror/i.test(body), `${where}: an onerror attribute survived — ${body}`);
    assert.ok(!/onclick/i.test(body), `${where}: an onclick attribute survived — ${body}`);
    assert.ok(!/javascript:/i.test(body), `${where}: a javascript: URL survived — ${body}`);
    assert.ok(!/<iframe/i.test(body), `${where}: an <iframe> survived — ${body}`);
}

test.before(async () => {
    ctx = await bootApp();
    // ADMIN so the create cooldown and the two-minute edit cooldown don't block
    // the second half of these tests.
    author = await ctx.User.create({
        fullName: "Mallory M",
        email: "mallory@example.com",
        password: "password123",
        isVerified: true,
        role: "ADMIN",
    });
    cookie = authCookie(author);
});

test.after(async () => {
    if (ctx) await ctx.stop();
});

test("a script tag and an onerror attribute POSTed to create do not reach the database", async () => {
    const { token, cookie: csrfCookie } = await csrfFor(request, ctx.app);

    // Saved as a draft: that path skips the cover-image/category/tag requirements,
    // so the request exercises sanitisation rather than the upload plumbing.
    const res = await request(ctx.app)
        .post("/blog")
        .set("Cookie", `${csrfCookie}; ${cookie}`)
        .type("form")
        .send({ _csrf: token, title: "Direct POST", action: "draft", body: `${XSS}<p>${FILLER}</p>` });

    assert.ok(res.status < 400, `create should succeed, got ${res.status}`);

    const blog = await ctx.Blog.findOne({ title: "Direct POST" }).lean();
    assert.ok(blog, "the post should exist");
    assertClean(blog.body, "create");
    assert.ok(blog.body.includes("word0"), "the writer's own text should survive");
});

test("a body made only of script markup is rejected rather than stored empty", async () => {
    const { token, cookie: csrfCookie } = await csrfFor(request, ctx.app);

    await request(ctx.app)
        .post("/blog")
        .set("Cookie", `${csrfCookie}; ${cookie}`)
        .type("form")
        .send({
            _csrf: token,
            title: "Script only",
            category: "Technology",
            tags: "x",
            aiCoverURL: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
            body: `<script>alert(1)</script>`,
        });

    assert.equal(
        await ctx.Blog.countDocuments({ title: "Script only" }),
        0,
        "sanitising to nothing should fail the content check, not store a blank post"
    );
});

test("a script tag and an onerror attribute POSTed to edit do not reach the database", async () => {
    const existing = await ctx.Blog.create({
        title: "Editable",
        body: `<p>${FILLER}</p>`,
        category: "Technology",
        createdBy: author._id,
        status: "published",
    });

    const { token, cookie: csrfCookie } = await csrfFor(request, ctx.app);

    const res = await request(ctx.app)
        .post(`/blog/edit/${existing._id}`)
        .set("Cookie", `${csrfCookie}; ${cookie}`)
        .type("form")
        .send({ _csrf: token, title: "Editable", category: "Technology", body: `${XSS}<p>${FILLER}</p>` });

    assert.ok(res.status < 400, `edit should succeed, got ${res.status}`);

    const after = await ctx.Blog.findById(existing._id).lean();
    assertClean(after.body, "edit");
    assert.ok(after.body.includes("word0"), "the writer's own text should survive");
});

test("the model refuses to store raw markup even when a write path forgets", async () => {
    // The backstop in models/blog.js. If a future route writes a body without
    // calling sanitizePostBody, the document still comes out clean.
    const blog = await ctx.Blog.create({
        title: "Straight to the model",
        body: `<p>${FILLER}</p>${XSS}`,
        category: "Technology",
        createdBy: author._id,
    });

    assertClean(blog.body, "model hook");
    const reloaded = await ctx.Blog.findById(blog._id).lean();
    assertClean(reloaded.body, "model hook (reloaded)");
});

test("the allowlist keeps the markup Quill actually produces", () => {
    const quillOutput =
        `<h2>Heading</h2>` +
        `<p><strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s></p>` +
        `<p><span style="color: rgb(230, 0, 0);">coloured</span></p>` +
        `<blockquote>quoted</blockquote>` +
        `<pre class="ql-syntax" spellcheck="false">const x = 1;\n</pre>` +
        `<ul><li>one</li><li class="ql-indent-1">nested</li></ul>` +
        `<ol><li>first</li></ol>` +
        `<p><a href="https://example.com" target="_blank">link</a></p>` +
        `<p><img src="https://res.cloudinary.com/demo/image/upload/sample.jpg" alt="pic"></p>`;

    const clean = sanitizePostBody(quillOutput);

    for (const fragment of [
        "<h2>", "<strong>", "<em>", "<u>", "<s>", "<blockquote>",
        'class="ql-syntax"', 'spellcheck="false"', 'class="ql-indent-1"',
        "<ul>", "<ol>", "<li>", 'href="https://example.com"', 'alt="pic"',
    ]) {
        assert.ok(clean.includes(fragment), `${fragment} should survive — got ${clean}`);
    }
    assert.ok(/style="[^"]*color:\s*rgb\(230, 0, 0\)/.test(clean), `inline colour should survive — got ${clean}`);
    // Quill writes target="_blank" with no rel; the sanitiser pairs one with it.
    assert.ok(/rel="noopener noreferrer"/.test(clean), `target=_blank links should get rel — got ${clean}`);
});

test("a data: image URL survives but a data: link does not", () => {
    // Quill's image button embeds uploads as base64, so <img src="data:"> has to work.
    const png = "data:image/png;base64,iVBORw0KGgo=";
    assert.ok(sanitizePostBody(`<img src="${png}">`).includes("data:image/png"));
    assert.ok(!sanitizePostBody(`<a href="${png}">x</a>`).includes("data:"));
});

test("stripTags removes markup without leaving script text behind", () => {
    assert.equal(stripTags("<p>hello <b>there</b></p>"), "hello there");
    assert.equal(stripTags("<script>alert(1)</script>"), "");
    assert.equal(stripTags(null), "");
});
