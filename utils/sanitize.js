const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const window = new JSDOM('').window;
const dompurify = createDOMPurify(window);

/**
 * Sanitizes HTML content.
 * @param {string} html - The raw HTML to sanitize.
 * @param {Object} [options] - Additional DOMPurify options.
 * @returns {string} - The sanitized HTML.
 */
const sanitizeHTML = (html, options = {}) => {
    if (typeof html !== 'string') return '';
    return dompurify.sanitize(html, {
        ALLOWED_TAGS: options.ALLOWED_TAGS || ['p', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'br', 'h1', 'h2', 'h3', 'blockquote', 'code', 'pre', 'img'],
        ALLOWED_ATTR: options.ALLOWED_ATTR || ['href', 'src', 'alt', 'title', 'class', 'target'],
        ...options
    });
};

/**
 * Strips all HTML tags from a string.
 * @param {string} text - The text to strip tags from.
 * @returns {string} - Plain text.
 */
const stripTags = (text) => {
    if (typeof text !== 'string') return '';
    return dompurify.sanitize(text, { ALLOWED_TAGS: [] });
};

module.exports = {
    sanitizeHTML,
    stripTags
};
