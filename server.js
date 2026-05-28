require('dotenv').config();

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const FormData = require("form-data");
const puppeteer = require("puppeteer"); // For smart fallback protection

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

const TRIPO_KEY = process.env.TRIPO_API_KEY;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function absoluteUrl(base, relative) {
    try {
        return new URL(relative, base).href;
    } catch {
        return null;
    }
}

// Fallback: If cheerio fails because of anti-bot blockers, take a clean screenshot snippet
async function getScreenshotFallback(targetUrl) {
    console.log("⚠️ Scraper blocked. Launching browser fallback layer...");
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 15000 });
        
        // Snip a small area where header/logos live
        const buffer = await page.screenshot({
            clip: { x: 0, y: 0, width: 400, height: 120 }
        });
        await browser.close();
        return buffer;
    } catch (err) {
        if (browser) await browser.close();
        throw new Error("Fallback engine failed: " + err.message);
    }
}

async function scrapeLogo(targetUrl) {
    const response = await axios.get(targetUrl, {
        timeout: 10000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
    });

    const html = response.data;
    const $ = cheerio.load(html);
    let logoUrl = null;

    // PRIORITY 1 → OpenGraph image
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
        logoUrl = absoluteUrl(targetUrl, ogImage);
    }

    // PRIORITY 2 → favicon
    if (!logoUrl) {
        const icon =
            $('link[rel="icon"]').attr("href") ||
            $('link[rel="shortcut icon"]').attr("href") ||
            $('link[rel="apple-touch-icon"]').attr("href");

        if (icon) {
            logoUrl = absoluteUrl(targetUrl, icon);
        }
    }

    // PRIORITY 3 → first logo-like image
    if (!logoUrl) {
        $("img").each((i, el) => {
            const src = $(el).attr("src") || "";
            const lower = src.toLowerCase();
            if (lower.includes("logo") || lower.includes("brand")) {
                logoUrl = absoluteUrl(targetUrl, src);
                return false;
            }
        });
    }

    return logoUrl;
}

async function uploadToTripo(imageBuffer) {
    const form = new FormData();
    
    form.append("file", imageBuffer, {
        filename: "logo.png",
        contentType: "image/png",
        knownLength: imageBuffer.length
    });

    const upload = await axios.post(
        "https://api.tripo3d.ai/v2/openapi/upload",
        form,
        {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${TRIPO_KEY}`
            }
        }
    );

    // Look for both variants to stay safe
    const fileToken = upload.data?.data?.file_token || upload.data?.data?.image_token;
    
    if (!fileToken) {
        console.error("Tripo Response Error Context:", upload.data);
        throw new Error("Tripo upload failed.");
    }
    return fileToken;
}

async function create3DTask(fileToken) {
    const response = await axios.post(
        "https://api.tripo3d.ai/v2/openapi/task",
        {
            type: "image_to_model",
            file: {
                file_token: fileToken
            }
        },
        {
            headers: {
                Authorization: `Bearer ${TRIPO_KEY}`,
                "Content-Type": "application/json"
            }
        }
    );

    const taskId = response.data?.data?.task_id;
    if (!taskId) {
        throw new Error("Task creation failed.");
    }
    return taskId;
}

async function waitForModel(taskId) {
    for (let i = 0; i < 60; i++) {
        await delay(5000);

        const response = await axios.get(
            `https://api.tripo3d.ai/v2/openapi/task/${taskId}`,
            {
                headers: {
                    Authorization: `Bearer ${TRIPO_KEY}`
                }
            }
        );

        const status = response.data?.data?.status;
        console.log(`[Tripo Monitor] Status: ${status}`);

        if (status === "success" || status === "succeeded") {
            const modelUrl = response.data?.data?.output?.model;
            if (modelUrl) return modelUrl;
        }

        if (status === "failed") {
            throw new Error("3D generation failed.");
        }
    }
    throw new Error("Timed out waiting for model.");
}

app.post("/detect-brand", async (req, res) => {
    try {
        let targetUrl = req.body.url;
        if (!targetUrl) {
            return res.status(400).json({ error: "Missing URL." });
        }

        if (!targetUrl.startsWith("http")) {
            targetUrl = "https://" + targetUrl;
        }

        console.log("Scanning:", targetUrl);
        let imageBuffer;
        let logoUrl = "Captured via Viewport Fallback";

        try {
            // Try standard cheerio scraping first
            const scrapedUrl = await scrapeLogo(targetUrl);
            if (!scrapedUrl) throw new Error("No image found in tags");
            
            logoUrl = scrapedUrl;
            console.log("Logo Found via Scraper:", logoUrl);

            const imageResponse = await axios.get(logoUrl, { responseType: "arraybuffer" });
            imageBuffer = Buffer.from(imageResponse.data);
            console.log("Image Downloaded successfully.");
        } catch (scrapeErr) {
            // If scraped gets blocked or fails, use Puppeteer fallback snapshot automatically
            imageBuffer = await getScreenshotFallback(targetUrl);
            console.log("Visual viewport frame captured instead.");
        }

        // STEP 3 → UPLOAD TO TRIPO
        const fileToken = await uploadToTripo(imageBuffer);
        console.log("Uploaded to Tripo:", fileToken);

        // STEP 4 → CREATE MODEL TASK
        const taskId = await create3DTask(fileToken);
        console.log("Task Created:", taskId);

        // STEP 5 → WAIT FOR MODEL
        const modelUrl = await waitForModel(taskId);
        console.log("Model Ready:", modelUrl);

        res.json({
            success: true,
            logoUrl,
            meshUrl: modelUrl
        });

    } catch (err) {
        console.error("Pipeline Error:", err.message);
        res.status(500).json({
            error: err.message
        });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});