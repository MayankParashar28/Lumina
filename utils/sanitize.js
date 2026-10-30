// Server-side HTML sanitisation for user-authored content.
//
// views/blog.ejs also runs DOMPurify in the browser before injecting a post's
// body, but that is a rendering convenience, not a security boundary: anything
// that POSTs straight to /blog or /blog/edit/:id skips the editor entirely, and
// whatever it sends is stored verbatim and served to every reader. This module
// is the boundary — it runs on the way IN, so the database never holds markup
// we would not be willing to serve.
//
// DOMPurify + jsdom rather than sanitize-html: both are already dependencies
// (dompurify is served to the browser from node_modules, jsdom is present), so
// this adds nothing to the install, and the server allowlist below is then
// enforced by the same library the client already uses.
const createDOMPurify = require('dompurify');

// jsdom costs ~100ms to load and a process that never sanitises (the worker)
// should not pay it, so the window is built on first use.
let dompurify = null;
function purifier() {
    if (dompurify) return dompurify;

    const { JSDOM } = require('jsdom');
    dompurify = createDOMPurify(new JSDOM('').window);

    // Quill writes target="_blank" on every link. Pair it with rel so the opened
    // page cannot reach back through window.opener.
    dompurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.hasAttribute('target')) {
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });

    return dompurify;
}

// What the editor actually produces. Quill 1.3.6 is configured (views/addBlog.ejs,
// views/editBlog.ejs) with: header 1-3, bold/italic/underline/strike, blockquote,
// code-block, ordered/bullet list, colour/background, link, image. That maps onto
// h1-h3, strong/em/u/s, blockquote, pre, ol/ul/li, span, a, img — plus p and br,
// which it emits for every paragraph and blank line.
//
// The rest of the list is close relatives a writer can get in by pasting (h4-h6,
// tables, definition lists, figures, hr, sub/sup, inline code). They render as
// text and cannot load or run anything, so permitting them avoids mangling an
// otherwise legitimate post.
//
// Deliberately absent: script, style, iframe, object, embed, form/input/button,
// svg, math, link, meta, base. There is no embed or video button in the toolbar,
// so no legitimate post contains an iframe, and the browser-side pass does not
// allow one either (DOMPurify's default HTML profile excludes it) — permitting
// them here would widen what readers are served, not preserve what writers wrote.
const POST_ALLOWED_TAGS = [
    // Blocks
    'p', 'div', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'figure', 'figcaption',
    'ol', 'ul', 'li', 'dl', 'dt', 'dd',
    // Inline
    'a', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins',
    'mark', 'small', 'sub', 'sup', 'code', 'kbd', 'samp', 'abbr', 'cite', 'q',
    // Media
    'img',
    // Tables
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
];

// `class` and `style` are both load-bearing for Quill output and are kept on
// purpose. Quill marks code blocks with class="ql-syntax", list indentation with
// class="ql-indent-N" and alignment with class="ql-align-*"; dropping class would
// flatten every code block and indented list in the archive. Colour and highlight
// are inline styles (style="color: rgb(...)"), and DOMPurify sanitises the CSS it
// finds in a style attribute, so expression()/url(javascript:) do not survive.
//
// No attribute here can execute: every on* handler is excluded by virtue of not
// being listed, and href/src values still go through DOMPurify's URI check, which
// rejects javascript: and allows data: only on <img> (which is how Quill's image
// button embeds an upload).
//
// Residual risk, accepted knowingly: `style` still lets an author apply arbitrary
// CSS (position:fixed and the like) inside their own post page. DOMPurify has no
// property-level allowlist, the browser-side pass permits the same thing today,
// and the outcome is an author defacing their own page — not script execution or
// session theft. Narrowing it to colour/background would need a custom CSS pass.
const POST_ALLOWED_ATTR = [
    'href', 'target', 'rel', 'title',
    'src', 'alt', 'width', 'height', 'loading',
    'class', 'style', 'dir', 'lang', 'spellcheck',
    'colspan', 'rowspan', 'scope', 'start', 'reversed', 'value',
    // Quill 2 marks bullet vs ordered items with data-list; harmless and future-proof.
    'data-list',
];

/**
 * Sanitizes HTML content.
 * @param {string} html - The raw HTML to sanitize.
 * @param {Object} [options] - Additional DOMPurify options.
 * @returns {string} - The sanitized HTML.
 */
const sanitizeHTML = (html, options = {}) => {
    if (typeof html !== 'string') return '';
    return purifier().sanitize(html, {
        ALLOWED_TAGS: options.ALLOWED_TAGS || POST_ALLOWED_TAGS,
        ALLOWED_ATTR: options.ALLOWED_ATTR || POST_ALLOWED_ATTR,
        ...options
    });
};

/**
 * Sanitizes a blog post body on its way into the database. Call this on every
 * write path that accepts post HTML; models/blog.js also applies it in a
 * pre-validate hook so a path that forgets cannot store raw markup.
 * @param {string} html - The submitted post body.
 * @returns {string} - The sanitized body.
 */
const sanitizePostBody = (html) => sanitizeHTML(html);

/**
 * Strips all HTML tags from a string.
 * @param {string} text - The text to strip tags from.
 * @returns {string} - Plain text.
 */
const stripTags = (text) => {
    if (typeof text !== 'string') return '';
    return purifier().sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
};

module.exports = {
    sanitizeHTML,
    sanitizePostBody,
    stripTags,
    POST_ALLOWED_TAGS,
    POST_ALLOWED_ATTR
};
