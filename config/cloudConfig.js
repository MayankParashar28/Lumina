const cloudinary = require('cloudinary').v2;
const multer = require('multer');
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// 🛠️ Custom multer storage engine for Cloudinary v2.
// Replaces the unmaintained `multer-storage-cloudinary` (which is locked to
// Cloudinary v1). It streams the uploaded file straight to Cloudinary and
// exposes the same fields the routes already rely on: `path` (secure URL),
// `filename` (public_id) and `secure_url`.
function createCloudinaryStorage(params = {}) {
    return {
        _handleFile(req, file, cb) {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: params.folder,
                    resource_type: 'image',
                    transformation: params.transformation,
                },
                (err, result) => {
                    if (err) return cb(err);
                    cb(null, {
                        path: result.secure_url,
                        filename: result.public_id,
                        secure_url: result.secure_url,
                        size: result.bytes,
                    });
                }
            );
            file.stream.on('error', cb);
            file.stream.pipe(uploadStream);
        },
        _removeFile(req, file, cb) {
            if (file && file.filename) {
                cloudinary.uploader.destroy(file.filename, () => cb(null));
            } else {
                cb(null);
            }
        },
    };
}

const storage = createCloudinaryStorage({
    folder: 'lumina_uploads',
    transformation: [{ width: 1200, crop: 'limit' }, { quality: 'auto' }, { fetch_format: 'auto' }],
});

// 🔒 File size limit (5MB) and MIME type validation
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
