const fs = require('fs');
const buffer = fs.readFileSync('public/images/default-cover.jpg');
console.log("Magic bytes:", buffer.toString('hex', 0, 4));
