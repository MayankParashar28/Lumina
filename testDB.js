require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/blogify")
  .then(async () => {
    const db = mongoose.connection.db;
    const blogs = await db.collection("blogs").find({}, { projection: { title: 1, coverImageURL: 1 } }).toArray();
    
    let pollinationsCount = 0;
    let pollinationsUrls = [];
    let cloudinaryCount = 0;
    let missingCount = 0;
    let otherCount = 0;

    for (const b of blogs) {
      if (!b.coverImageURL) {
        missingCount++;
      } else if (b.coverImageURL.includes('pollinations.ai')) {
        pollinationsCount++;
        if (pollinationsUrls.length < 2) pollinationsUrls.push(b.coverImageURL);
      } else if (b.coverImageURL.includes('cloudinary.com')) {
        cloudinaryCount++;
      } else {
        otherCount++;
      }
    }

    console.log(`\n=== Database Image Breakdown ===`);
    console.log(`Total Blogs: ${blogs.length}`);
    console.log(`Cloudinary Hosted (Working): ${cloudinaryCount}`);
    console.log(`Pollinations Source (Broken): ${pollinationsCount}`);
    console.log(`Other Sources: ${otherCount}`);
    console.log(`Missing Image: ${missingCount}`);
    
    if (pollinationsUrls.length > 0) {
      console.log(`\nExample Pollinations URL currently failing: ${pollinationsUrls[0]}`);
      try {
        const fetch = require('node-fetch'); // Use node-fetch for Node v16 compatibility if needed, or global fetch
        const res = await globalThis.fetch(pollinationsUrls[0]);
        console.log(`HTTP Status from Pollinations: ${res.status} ${res.statusText}`);
      } catch (err) {
        console.log(`Fetch Error: ${err.message}`);
      }
    }

    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
