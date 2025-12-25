/**
 * Optimizes a Cloudinary image URL by injecting 'f_auto' and 'q_auto'.
 * This ensures WebP/Avif delivery and automatic quality adjustments.
 * 
 * @param {string} url - The original Cloudinary image URL
 * @param {object} options - Optional resizing parameters (width, height, crop)
 * @returns {string} - The optimized URL
 */
function optimizeImage(url, options = {}) {
    if (!url || typeof url !== 'string') return url;

    // Only process Cloudinary URLs. Others (like Pollinations.ai AI images) are returned as is.
    if (!url.includes('res.cloudinary.com')) return url;

    const { width, height, crop = 'fill' } = options;

    // Find the insertion point for transformations (after '/upload/')
    const uploadIndex = url.indexOf('/upload/');
    if (uploadIndex === -1) return url;

    // Define the new transformations
    let transformations = 'f_auto,q_auto';

    if (width) transformations += `,w_${width}`;
    if (height) transformations += `,h_${height}`;
    if (width || height) transformations += `,c_${crop}`;

    // Reconstruct the URL by inserting transformations after /upload/
    const part1 = url.substring(0, uploadIndex + 8); // includes '/upload/'
    const part2 = url.substring(uploadIndex + 8);

    return `${part1}${transformations}/${part2}`;
}

module.exports = { optimizeImage };
