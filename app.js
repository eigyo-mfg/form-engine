const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

async function run() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (req.url().includes('www.google-analytics.com')) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.goto('https://www.tgl.co.jp/emp/inquiry.php', { waitUntil: 'networkidle0' });

    const html = await page.content();
    const $ = cheerio.load(html);

    let formsHTML = [];
    $('form').each(function() {
        formsHTML.push($(this).html());
    });

    console.log(formsHTML);

    // If no form is found, look for iframe
    if (formsHTML.length === 0) {
        const iframes = await page.$$('iframe');
        for (let iframe of iframes) {
            try {
                const frame = await iframe.contentFrame();
                await frame.waitForSelector('form', { timeout: 5000 });

                const iframeHTML = await frame.content();
                const $iframe = cheerio.load(iframeHTML);
                $iframe('form').each(function() {
                    formsHTML.push($iframe(this).html());
                });
            } catch (error) {
                console.log('No form found in this iframe');
            }
        }
    }

    if (formsHTML.length === 0) {
        console.log("No form found. Exiting...");
        await browser.close();
        return;
    }

    // Find the longest form HTML
    let longestFormHTML = formsHTML.reduce((a, b) => a.length > b.length ? a : b, "");

    // Check if the HTML is malformed
    const malformedHtmlRegex = /<([a-z][a-z0-9]*)\b[^>]*>(.*?)<\/\1>/g;
    if (!malformedHtmlRegex.test(longestFormHTML)) {
        console.log("The HTML is malformed. Executing alternative process...");

        // Extract form content using regex
        const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi;
        let match;
        while ((match = formRegex.exec(html)) !== null) {
            console.log("Found a form: ", match[0]);
        }
    } else {
        console.log(longestFormHTML);
    }

    await browser.close();
}

run().catch(console.error);