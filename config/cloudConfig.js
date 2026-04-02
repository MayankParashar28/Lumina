const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'lumina_uploads',
        allowedFormats: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        transformation: [{ width: 1200, crop: "limit" }, { quality: "auto" }, { fetch_format: "auto" }]
    },
});

// 🔒 Fixed: Add file size limit (5MB) and MIME type validation
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files (JPEG, PNG, WEBP, GIF) are allowed.'), false);
        }
    }
});

module.exports = {
    cloudinary,
    storage,
    upload // Export pre-configured multer instance
};
