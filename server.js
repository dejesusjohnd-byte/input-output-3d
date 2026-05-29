require('dotenv').config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const FormData = require("form-data");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

const TRIPO_KEY = process.env.TRIPO_API_KEY;
const BASE_OUTPUT_DIR = path.join(__dirname, "creations");

if (!fs.existsSync(BASE_OUTPUT_DIR)) {
    fs.mkdirSync(BASE_OUTPUT_DIR, { recursive: true });
}

const pipelineRecoveryCache = new Map();

function absoluteUrl(base, relative) {
    try { return new URL(relative, base).href; } catch { return null; }
}

function getSafeBaseName(urlStr) {
    return urlStr
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/[^a-zA-Z0-9.]/g, '_')
        .toLowerCase();
}

// Fixed Naming Engine: creations/YYYY-MM-DD/HHMMSS_domain_
function getChronologicalFolder(urlStr) {
    const now = new Date();
    
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    
    const HH = String(now.getHours()).padStart(2, '0');
    const Min = String(now.getMinutes()).padStart(2, '0');
    const SS = String(now.getSeconds()).padStart(2, '0');

    const dateFolder = `${YYYY}-${MM}-${DD}`;
    const safeDomain = getSafeBaseName(urlStr);
    const sessionFolderName = `${HH}${Min}${SS}_${safeDomain}_`; // Trailing underscore preserved per specification
    
    const targetDir = path.join(BASE_OUTPUT_DIR, dateFolder, sessionFolderName);
    
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    return { targetDir, sessionFolderName, dateFolder };
}

// Alpha Padding & Anti-Aliased Contrast Normalization
async function normalizeImageAsset(inputBuffer) {
    try {
        const img = await loadImage(inputBuffer);
        const maxDim = Math.max(img.width, img.height);
        const squareSize = maxDim + 120; 
        
        const canvas = createCanvas(squareSize, squareSize);
        const ctx = canvas.getContext('2d');
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, squareSize, squareSize);
        
        const offsetX = (squareSize - img.width) / 2;
        const offsetY = (squareSize - img.height) / 2;
        ctx.drawImage(img, offsetX, offsetY);
        
        const imgData = ctx.getImageData(0, 0, squareSize, squareSize);
        const pixels = imgData.data;
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i+3] > 40) { 
                rSum += pixels[i];
                gSum += pixels[i+1];
                bSum += pixels[i+2];
                count++;
            }
        }
        
        if (count > 0) {
            const averageBrightness = (rSum + gSum + bSum) / (count * 3);
            if (averageBrightness < 75) { 
                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i+3] > 0) {
                        pixels[i]   = 255 - pixels[i];
                        pixels[i+1] = 255 - pixels[i+1];
                        pixels[i+2] = 255 - pixels[i+2];
                    }
                }
                ctx.putImageData(imgData, 0, 0);
            }
        }
        return canvas.toBuffer('image/png');
    } catch (e) {
        return inputBuffer;
    }
}

function extractGlbUrlDeep(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') {
        const cleanStr = obj.toLowerCase().split('?')[0];
        if (cleanStr.endsWith('.glb')) return obj;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = extractGlbUrlDeep(item);
            if (found) return found;
        }
    }
    if (typeof obj === 'object') {
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const found = extractGlbUrlDeep(obj[key]);
                if (found) return found;
            }
        }
    }
    return null;
}

// Position-Agnostic Intelligent Bounding Box Scraper
async function getScreenshotFallback(targetUrl) {
    console.log("⚙️ [Phase 2/6] [Puppeteer] Executing layout-aware visual geometry engine...");
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        
        await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 20000 });
        
        // Remove disruptive popups and inject standard background rules
        await page.evaluate(() => {
            const style = document.createElement('style');
            style.innerHTML = '* { background-color: #ffffff !important; color: #000000 !important; transition: none !important; animation: none !important; }';
            document.head.appendChild(style);
            
            const overlays = ['[id*="cookie"]', '[class*="cookie"]', '[id*="consent"]', '[class*="modal"]', '[class*="popup"]', '.banner'];
            overlays.forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
        });

        // Advanced internal node evaluator to scan for logos placed anywhere on the screen
        const targetClip = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('img, svg, a, div, header'));
            let bestCandidate = null;
            let highestScore = 0;

            elements.forEach(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width < 30 || rect.height < 15 || rect.width > 500 || rect.height > 250) return;

                let score = 0;
                const id = (el.id || '').toLowerCase();
                const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                const src = el.tagName === 'IMG' ? (el.getAttribute('src') || '').toLowerCase() : '';

                if (id.includes('logo') || className.includes('logo') || src.includes('logo')) score += 100;
                if (id.includes('brand') || className.includes('brand') || src.includes('brand')) score += 80;
                if (el.tagName === 'HEADER' || el.closest('header')) score += 20;

                // Position scoring adjustments (prefer prominent elements, but accept any valid placement)
                if (rect.top >= 0 && rect.top <= 150) score += 15; 
                
                if (score > highestScore) {
                    highestScore = score;
                    bestCandidate = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
                }
            });

            // Return coordinates if a reliable high-scoring element matches anywhere on screen
            if (bestCandidate && highestScore > 30) {
                return {
                    x: Math.max(0, bestCandidate.x - 10),
                    y: Math.max(0, bestCandidate.y - 10),
                    width: bestCandidate.width + 20,
                    height: bestCandidate.height + 20
                };
            }
            return null;
        });

        let buffer;
        if (targetClip) {
            console.log(`🎯 [Puppeteer] Snapping coordinates anywhere-on-page: [X:${targetClip.x}, Y:${targetClip.y}]`);
            buffer = await page.screenshot({ clip: targetClip, omitBackground: true });
        } else {
            console.log("⚠️ [Puppeteer] Position scanning coordinates inconclusive. Dropping back to absolute frame.");
            buffer = await page.screenshot({ clip: { x: 0, y: 0, width: 500, height: 160 }, omitBackground: true });
        }

        await browser.close();
        return buffer;
    } catch (err) {
        if (browser) await browser.close();
        throw new Error("Puppeteer isolated rendering run crashed: " + err.message);
    }
}

async function scrapeLogo(targetUrl) {
    console.log(`🔎 [Phase 1/6] [Scraper] Parsing HTML markup parameters...`);
    const response = await axios.get(targetUrl, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });

    const $ = cheerio.load(response.data);
    let logoUrl = null;

    const isValidFormat = (urlStr) => {
        if (!urlStr) return false;
        const low = urlStr.toLowerCase().split('?')[0];
        return low.endsWith('.png') || low.endsWith('.jpg') || low.endsWith('.jpeg') || low.endsWith('.webp') || low.endsWith('.svg');
    };

    // Check primary meta social graphs first
    const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content");
    if (ogImage && isValidFormat(absoluteUrl(targetUrl, ogImage))) {
        return absoluteUrl(targetUrl, ogImage);
    }

    // Comprehensive DOM scan
    $("img, link").each((_, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("href") || "";
        const rel = $(el).attr("rel") || "";
        const fullUrl = absoluteUrl(targetUrl, src);

        if (isValidFormat(fullUrl)) {
            if (src.toLowerCase().includes("logo") || src.toLowerCase().includes("brand") || rel.toLowerCase().includes("icon")) {
                logoUrl = fullUrl;
                return false; 
            }
        }
    });

    return logoUrl;
}

app.post("/detect-brand", async (req, res) => {
    try {
        let targetUrl = req.body.url;
        if (!targetUrl) return res.status(400).json({ error: "Missing source validation reference endpoint target URL." });
        if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

        const { targetDir, sessionFolderName, dateFolder } = getChronologicalFolder(targetUrl);

        if (pipelineRecoveryCache.has(targetUrl)) {
            const cachedData = pipelineRecoveryCache.get(targetUrl);
            return res.json({ 
                success: true, isCached: true, charged: false, 
                logoUrl: cachedData.logoUrl, taskId: cachedData.taskId, outputFolder: targetDir 
            });
        }

        let rawImageBuffer = null;
        let logoUrl = "Captured via Dynamic Fallback Engine";

        try {
            const scrapedUrl = await scrapeLogo(targetUrl);
            if (scrapedUrl) {
                logoUrl = scrapedUrl;
                const imageResponse = await axios.get(logoUrl, { responseType: "arraybuffer" });
                rawImageBuffer = Buffer.from(imageResponse.data);
            } else {
                throw new Error("Standard metadata hooks skipped asset detection.");
            }
        } catch (scrapeErr) {
            rawImageBuffer = await getScreenshotFallback(targetUrl);
        }

        if (!rawImageBuffer || rawImageBuffer.length < 200) {
            return res.status(422).json({ error: "Asset extraction footprint boundary check rejected." });
        }

        const normalizedBuffer = await normalizeImageAsset(rawImageBuffer);
        const localImgPath = path.join(targetDir, "source_logo.png");
        fs.writeFileSync(localImgPath, normalizedBuffer);

        console.log(`📤 [Phase 3/6] [Tripo API] Transferring optimized map buffer stream to remote asset node...`);
        const form = new FormData();
        form.append("file", normalizedBuffer, { filename: "logo.png", contentType: "image/png", knownLength: normalizedBuffer.length });

        const upload = await axios.post("https://api.tripo3d.ai/v2/openapi/upload", form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${TRIPO_KEY}` }
        });

        const fileToken = upload.data?.data?.file_token || upload.data?.data?.image_token;
        if (!fileToken) throw new Error("Tripo core file token mapping dropped.");

        console.log(`🚀 [Phase 4/6] [Tripo API] Synchronizing mesh generation execution worker sequence...`);
        const taskResponse = await axios.post(
            "https://api.tripo3d.ai/v2/openapi/task",
            { type: "image_to_model", mode: "pbr", file: { file_token: fileToken, orthogonal_view: "front" } },
            { headers: { Authorization: `Bearer ${TRIPO_KEY}`, "Content-Type": "application/json" } }
        );

        const taskId = taskResponse.data?.data?.task_id;
        if (!taskId) throw new Error("Tripo pipeline initialization schedule rejected.");

        pipelineRecoveryCache.set(targetUrl, { logoUrl, taskId });
        res.json({ success: true, isCached: false, charged: true, logoUrl, taskId, outputFolder: targetDir, sessionFolderName, dateFolder });

    } catch (err) {
        console.error("❌ [Pipeline Router Engine Intercept Exception]", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get("/task-status/:taskId", async (req, res) => {
    try {
        const response = await axios.get(`https://api.tripo3d.ai/v2/openapi/task/${req.params.taskId}`, {
            headers: { Authorization: `Bearer ${TRIPO_KEY}` }
        });
        const data = response.data?.data;
        if (!data) return res.status(404).json({ error: "Context task mapping not tracking on remote server." });

        res.json({ 
            status: data.status, 
            progress: data.progress !== undefined ? data.progress : (data.status === "success" ? 100 : 0), 
            modelUrl: extractGlbUrlDeep(data) 
        });
    } catch (err) {
        res.status(500).json({ error: "Task matrix routing inquiry tracking lost." });
    }
});

app.post("/backup-model", async (req, res) => {
    try {
        const { modelUrl, outputFolder } = req.body;
        if (!modelUrl || !outputFolder) return res.status(400).json({ error: "Invalid path reference execution limits." });

        const safeResolutionPath = path.resolve(outputFolder);
        if (!safeResolutionPath.startsWith(BASE_OUTPUT_DIR)) {
            return res.status(403).json({ error: "Security exception: Output directory escapes sandbox path." });
        }

        console.log(`💾 [Phase 5/6] [Archiver] Downloading raw network mesh payload arrays...`);
        const fileResponse = await axios({ method: 'get', url: modelUrl, responseType: 'arraybuffer' });
        
        const localModelPath = path.join(safeResolutionPath, "model.glb");
        fs.writeFileSync(localModelPath, Buffer.from(fileResponse.data));

        console.log(`✅ [Phase 6/6] [Archiver] Matrix save task terminated successfully: ${localModelPath}`);
        res.json({ success: true, localFile: localModelPath });
    } catch (err) {
        res.status(500).json({ error: "Persistent disk layer operations dropped." });
    }
});

app.get("/fetch-model", async (req, res) => {
    try {
        const targetModelUrl = req.query.url;
        if (!targetModelUrl) return res.status(400).send("Context data target model key mapping reference required.");
        const streamResponse = await axios({ method: 'get', url: targetModelUrl, responseType: 'stream' });
        res.setHeader('Content-Type', 'model/gltf-binary');
        streamResponse.data.pipe(res);
    } catch (err) {
        res.status(500).send("Network stream pipe execution collapsed.");
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`==================================================================`);
    console.log(`📡 Diagnostic Monitoring Server Booted at http://localhost:${PORT}`);
    console.log(`📁 Flat Structure Nested Route Configured Safe Inside: ${BASE_OUTPUT_DIR}`);
    console.log(`==================================================================`);
});