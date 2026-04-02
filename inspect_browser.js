const puppeteer = require('puppeteer');

(async () => {
    console.log("Launching headless browser...");
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    
    // Listen for all console events and log them
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err.toString()));
    page.on('requestfailed', request => {
        console.log(`REQUEST FAILED: ${request.url()} - ${request.failure()?.errorText}`);
    });

    console.log("Navigating to http://localhost:8000...");
    await page.goto('http://localhost:8000', { waitUntil: 'networkidle2' });

    // Ensure we are logged in if redirected
    if (page.url().includes('signin')) {
        console.log("Redirected to sign-in. Attempting login...");
        // Assuming there is an email and password field, let's look for test user
        // Or better yet, we don't know the password...
        console.log("We need to log in! Cannot inspect feed without auth.");
        await browser.close();
        process.exit(1);
    }

    console.log("Waiting for images...");
    await new Promise(r => setTimeout(r, 2000));

    // Inspect the first broken image container
    const brokenImageData = await page.evaluate(() => {
        // Find an image that either failed to load or has the fallback URL
        const imgs = document.querySelectorAll('.card-image-wrapper img');
        if (imgs.length === 0) return { error: "No images found!" };
        
        // Let's get the 2nd one (just a random one in the feed to check)
        // Find one that we know was "pollinations"
        let targetImg = null;
        for (const img of imgs) {
             if (img.src.includes('default-cover') || img.src.includes('pollinations') || img.naturalWidth === 0) {
                 targetImg = img;
                 break;
             }
        }
        
        if (!targetImg) return { error: "Couldn't pinpoint the fallback image." };
        
        return {
            src: targetImg.src,
            outerHTML: targetImg.outerHTML,
            naturalWidth: targetImg.naturalWidth,
            naturalHeight: targetImg.naturalHeight,
            complete: targetImg.complete,
            parentHTML: targetImg.parentElement.outerHTML,
            displayStyle: window.getComputedStyle(targetImg).display,
            visibilityStyle: window.getComputedStyle(targetImg).visibility,
            opacityStyle: window.getComputedStyle(targetImg).opacity,
            widthStyle: window.getComputedStyle(targetImg).width,
            heightStyle: window.getComputedStyle(targetImg).height
        };
    });

    console.log("\n====== BROKEN IMAGE ANALYSIS ======");
    console.log(JSON.stringify(brokenImageData, null, 2));

    await browser.close();
})();
