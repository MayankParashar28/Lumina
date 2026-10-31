/**
 * Guards the hand-rolled Cloudinary multer storage engine in
 * config/cloudConfig.js against multer upgrades.
 *
 * The engine implements multer's private storage contract (_handleFile /
 * _removeFile, and file.stream), so a multer major bump can break uploads
 * without any of our own code changing. Cloudinary itself is stubbed — the point
 * is the multer <-> engine wiring, not the network call.
 */
const { test, before } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const request = require("supertest");

const { cloudinary, upload } = require("../config/cloudConfig");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

let app;
let uploadedBytes;

before(() => {
  // Stand in for cloudinary.uploader.upload_stream: a writable that collects the
  // piped bytes and then reports success the way the real SDK does.
  cloudinary.uploader.upload_stream = (opts, cb) => {
    const { Writable } = require("node:stream");
    const chunks = [];
    const w = new Writable({
      write(chunk, _enc, next) {
        chunks.push(chunk);
        next();
      },
    });
    w.on("finish", () => {
      uploadedBytes = Buffer.concat(chunks);
      cb(null, {
        secure_url: "https://res.cloudinary.com/demo/image/upload/test.png",
        public_id: `${opts.folder}/test`,
        bytes: uploadedBytes.length,
      });
    });
    return w;
  };

  app = express();
  app.post("/up", upload.single("pic"), (req, res) =>
    res.json({ path: req.file.path, filename: req.file.filename, size: req.file.size })
  );
  // multer surfaces rejections (size, MIME) as errors on the middleware.
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
});

test("an accepted image is streamed through to the storage engine", async () => {
  const res = await request(app).post("/up").attach("pic", PNG, "pixel.png");

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.path, "https://res.cloudinary.com/demo/image/upload/test.png");
  assert.strictEqual(res.body.filename, "lumina_uploads/test");
  // The engine must forward the real bytes, not an empty or truncated stream.
  assert.ok(uploadedBytes.equals(PNG), "piped bytes should match the uploaded file");
  assert.strictEqual(res.body.size, PNG.length);
});

test("a disallowed MIME type is rejected by fileFilter", async () => {
  const res = await request(app)
    .post("/up")
    .attach("pic", Buffer.from("#!/bin/sh\n"), { filename: "x.sh", contentType: "application/x-sh" });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /Only image files/);
});

test("a file over the 5MB limit is rejected", async () => {
  const tooBig = Buffer.alloc(6 * 1024 * 1024, 0x61);
  const res = await request(app)
    .post("/up")
    .attach("pic", tooBig, { filename: "big.png", contentType: "image/png" });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /File too large/i);
});
