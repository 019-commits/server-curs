const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");

const app = express();

const PORT = process.env.PORT || 3000;
const CHANNEL = "LoyaltySwift";

const TELEGRAM_URL = `https://t.me/s/${CHANNEL}`;

const CACHE_TTL = 2 * 60 * 1000;
const MAX_POSTS_TO_CHECK = 5;
const MIN_RATES_REQUIRED = 6;

let cachedRates = null;
let cachedPost = null;
let cachedOcrText = null;
let lastFetch = 0;
let updateInProgress = false;

// ============================================================
// LOG
// ============================================================

function log(...args) {
    console.log(
        `[${new Date().toISOString()}]`,
        ...args
    );
}

// ============================================================
// NUMBER
// ============================================================

function toNumber(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    const n = Number(
        String(value)
            .replace(/\s/g, "")
            .replace(",", ".")
            .trim()
    );

    return Number.isFinite(n) ? n : null;
}

// ============================================================
// NORMALIZE OCR
// ============================================================

function normalizeOCR(text) {
    let s = String(text || "");

    s = s
        .replace(/\r/g, "\n")
        .replace(/[–—−]/g, "-");

    // USD
    s = s
        .replace(/\bU5D\b/gi, "USD")
        .replace(/\bUSO\b/gi, "USD")
        .replace(/\bUsD\b/g, "USD");

    // JPY
    s = s
        .replace(/\bJpY\b/g, "JPY")
        .replace(/\bJPV\b/gi, "JPY")
        .replace(/\bJY\b/gi, "JPY")
        .replace(/\b13PY\b/gi, "JPY")
        .replace(/\bI3PY\b/gi, "JPY")
        .replace(/\bIJPY\b/gi, "JPY")
        .replace(/\bJ3Y\b/gi, "JPY");

    // KRW
    s = s
        .replace(/\bKRVV\b/gi, "KRW")
        .replace(/\bKRV\b/gi, "KRW");

    // CNY
    s = s
        .replace(/\b1eNy\b/gi, "1 CNY")
        .replace(/\beNy\b/g, "CNY")
        .replace(/\bENY\b/g, "CNY")
        .replace(/\beNY\b/g, "CNY")
        .replace(/\bCnY\b/g, "CNY")
        .replace(/\bCNU\b/gi, "CNY")
        .replace(/\bCNV\b/gi, "CNY");

    // THB
    s = s
        .replace(/\bTH8\b/gi, "THB")
        .replace(/\bTHВ\b/gi, "THB")
        .replace(/\bTНB\b/gi, "THB")
        .replace(/\bтнв\b/gi, "THB");

    // AED
    s = s
        .replace(/\bAЕD\b/gi, "AED")
        .replace(/\bАЕD\b/gi, "AED")
        .replace(/\bАЕр\b/gi, "AED")
        .replace(/\bАЕР\b/gi, "AED")
        .replace(/\bAЕр\b/gi, "AED");

    // IDUBID
    s = s
        .replace(/IDUBlD/gi, "IDUBID")
        .replace(/IDUB1D/gi, "IDUBID");

    return s
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean)
        .join("\n");
}

// ============================================================
// EXTRACT RATES
// ============================================================

function extractRates(rawText) {

    const text = normalizeOCR(rawText);

    console.log("");
    console.log("========== OCR TEXT ==========");
    console.log(text);
    console.log("==============================");
    console.log("");

    const lines = text
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean);

    const rates = {
        USD: null,
        USD_IDUBID: null,

        JPY_SWIFT: null,
        JPY_AFA_CASH: null,
        JPY_AFA_QR: null,

        KRW: null,
        AED: null,
        CNY: null,
        THB: null
    };

    // ========================================================
    // USD
    // ========================================================

    const usd = [];

    for (const line of lines) {

        const m = line.match(
            /\b1?\s*USD\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        const value = toNumber(m[1]);

        if (
            value >= 50 &&
            value <= 150
        ) {
            usd.push({
                value,
                line
            });
        }
    }

    if (usd.length) {
        rates.USD = usd[0].value;
    }

    for (const item of usd) {
        if (/IDUBID/i.test(item.line)) {
            rates.USD_IDUBID = item.value;
        }
    }

    if (
        rates.USD_IDUBID === null &&
        usd.length >= 2
    ) {
        rates.USD_IDUBID =
            usd[1].value;
    }

    // ========================================================
    // KRW
    // ========================================================

    for (const line of lines) {

        const m = line.match(
            /1000\s*KRW\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        const value = toNumber(m[1]);

        if (
            value >= 10 &&
            value <= 100
        ) {
            rates.KRW = value;
            break;
        }
    }

    // ========================================================
    // AED
    // ========================================================

    for (const line of lines) {

        const m = line.match(
            /1\s*AED\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        const value = toNumber(m[1]);

        if (
            value >= 5 &&
            value <= 50
        ) {
            rates.AED = value;
            break;
        }
    }

    // ========================================================
    // THB
    // ========================================================

    for (const line of lines) {

        const m = line.match(
            /1\s*THB\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        const value = toNumber(m[1]);

        if (
            value >= 0.1 &&
            value <= 10
        ) {
            rates.THB = value;
            break;
        }
    }

    // ========================================================
    // CNY
    // ========================================================

    for (const line of lines) {

        const m = line.match(
            /1\s*CNY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        let value = toNumber(m[1]);

        if (value >= 100) {
            value /= 100;
        }

        if (
            value >= 1 &&
            value <= 30
        ) {
            rates.CNY = value;
            break;
        }
    }

    // ========================================================
    // JPY SWIFT
    // ========================================================

    for (const line of lines) {

        const m = line.match(
            /100\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        const value = toNumber(m[1]);

        if (
            value >= 10 &&
            value <= 100
        ) {
            rates.JPY_SWIFT = value;
            break;
        }
    }

    // ========================================================
    // AFA JPY
    // ========================================================

    const afa = [];

    for (const line of lines) {

        const m = line.match(
            /1\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!m) continue;

        let value = toNumber(m[1]);

        if (value >= 1000) {
            value /= 100;
        }

        if (
            value >= 10 &&
            value <= 100
        ) {
            afa.push(value);
        }
    }

    /*
       Для твоей картинки:

       1JPY = 5580
       1JPY = 55.30

       получаем:

       55.80
       55.30
    */

    if (afa.length >= 1) {
        rates.JPY_AFA_CASH = afa[0];
    }

    if (afa.length >= 2) {
        rates.JPY_AFA_QR = afa[1];
    }

    // Если QR отдельно не распознался,
    // но есть второй курс
    if (
        rates.JPY_AFA_QR === null &&
        afa.length >= 2
    ) {
        rates.JPY_AFA_QR = afa[1];
    }

    // ========================================================
    // RESULT
    // ========================================================

    const count =
        Object.values(rates)
            .filter(
                x =>
                    x !== null &&
                    Number.isFinite(x)
            )
            .length;

    console.log(
        "💰 Результат OCR:",
        JSON.stringify(
            rates,
            null,
            2
        )
    );

    console.log(
        `📊 Найдено курсов: ${count}/9`
    );

    return rates;
}

// ============================================================
// VALIDATE
// ============================================================

function countRates(rates) {
    return Object.values(rates || {})
        .filter(
            x =>
                x !== null &&
                Number.isFinite(x)
        )
        .length;
}

function validateRates(rates) {

    if (!rates) {
        return false;
    }

    if (
        rates.USD !== null &&
        (
            rates.USD < 50 ||
            rates.USD > 150
        )
    ) return false;

    if (
        rates.JPY_SWIFT !== null &&
        (
            rates.JPY_SWIFT < 10 ||
            rates.JPY_SWIFT > 100
        )
    ) return false;

    if (
        rates.JPY_AFA_CASH !== null &&
        (
            rates.JPY_AFA_CASH < 10 ||
            rates.JPY_AFA_CASH > 100
        )
    ) return false;

    if (
        rates.JPY_AFA_QR !== null &&
        (
            rates.JPY_AFA_QR < 10 ||
            rates.JPY_AFA_QR > 100
        )
    ) return false;

    if (
        rates.KRW !== null &&
        (
            rates.KRW < 10 ||
            rates.KRW > 100
        )
    ) return false;

    if (
        rates.AED !== null &&
        (
            rates.AED < 5 ||
            rates.AED > 50
        )
    ) return false;

    if (
        rates.CNY !== null &&
        (
            rates.CNY < 1 ||
            rates.CNY > 30
        )
    ) return false;

    if (
        rates.THB !== null &&
        (
            rates.THB < 0.1 ||
            rates.THB > 10
        )
    ) return false;

    return (
        countRates(rates) >=
        MIN_RATES_REQUIRED
    );
}

// ============================================================
// TELEGRAM HTML
// ============================================================

async function getTelegramHTML() {

    log(
        `🌐 Загружаем ${TELEGRAM_URL}`
    );

    const response =
        await axios.get(
            TELEGRAM_URL,
            {
                timeout: 20000,

                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

                    "Accept":
                        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

                    "Accept-Language":
                        "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
                }
            }
        );

    return response.data;
}

// ============================================================
// URL CLEAN
// ============================================================

function cleanImageUrl(url) {

    if (!url) {
        return null;
    }

    let result =
        String(url)
            .trim()
            .replace(/^["']/, "")
            .replace(/["']$/, "");

    // HTML entities
    result = result
        .replace(/&amp;/g, "&")
        .replace(/&#38;/g, "&")
        .replace(/&#x26;/gi, "&");

    // Backslashes
    result = result
        .replace(/\\\//g, "/");

    /*
       Telegram иногда отдаёт URL,
       который уже начинается с https.
    */

    if (
        result.startsWith("https://") ||
        result.startsWith("http://")
    ) {
        return result;
    }

    /*
       Если вдруг URL относительный.
    */

    if (result.startsWith("//")) {
        return "https:" + result;
    }

    if (result.startsWith("/")) {
        return "https://t.me" + result;
    }

    return null;
}

// ============================================================
// EXTRACT POSTS
// ============================================================

function extractPosts(html) {

    const posts = [];

    /*
       Ищем непосредственно:

       data-post="LoyaltySwift/1340"
    */

    const regex =
        /data-post=["']LoyaltySwift\/(\d+)["']/gi;

    let match;

    while (
        (match = regex.exec(html)) !== null
    ) {

        const id =
            Number(match[1]);

        const start =
            Math.max(
                0,
                match.index - 5000
            );

        const end =
            Math.min(
                html.length,
                match.index + 20000
            );

        const block =
            html.substring(
                start,
                end
            );

        let imageUrl = null;

        // ----------------------------------------------------
        // 1. background-image
        // ----------------------------------------------------

        const bgMatches =
            block.match(
                /background-image\s*:\s*url\(\s*([^)]*?)\s*\)/gi
            );

        if (bgMatches) {

            for (
                const bg of bgMatches
            ) {

                const inside =
                    bg.replace(
                        /^.*url\(\s*/i,
                        ""
                    )
                    .replace(
                        /\s*\)$/i,
                        ""
                    )
                    .trim();

                const candidate =
                    cleanImageUrl(
                        inside
                    );

                if (
                    candidate &&
                    (
                        candidate.includes(
                            "telegram"
                        ) ||
                        candidate.includes(
                            "cdn"
                        ) ||
                        /\.(jpg|jpeg|png|webp)/i.test(
                            candidate
                        )
                    )
                ) {
                    imageUrl =
                        candidate;

                    break;
                }
            }
        }

        // ----------------------------------------------------
        // 2. tgme_widget_message_photo
        // ----------------------------------------------------

        if (!imageUrl) {

            const photoMatch =
                block.match(
                    /tgme_widget_message_photo[^>]*style=["'][^"']*url\(([^)]+)\)/i
                );

            if (photoMatch) {
                imageUrl =
                    cleanImageUrl(
                        photoMatch[1]
                    );
            }
        }

        // ----------------------------------------------------
        // 3. обычный img
        // ----------------------------------------------------

        if (!imageUrl) {

            const images =
                block.match(
                    /<img[^>]+src=["']([^"']+)["']/gi
                );

            if (images) {

                for (
                    const imageTag of images
                ) {

                    const m =
                        imageTag.match(
                            /src=["']([^"']+)["']/i
                        );

                    if (!m) continue;

                    const candidate =
                        cleanImageUrl(
                            m[1]
                        );

                    if (
                        candidate &&
                        /\.(jpg|jpeg|png|webp)/i.test(
                            candidate
                        )
                    ) {
                        imageUrl =
                            candidate;

                        break;
                    }
                }
            }
        }

        // ----------------------------------------------------
        // POST TEXT
        // ----------------------------------------------------

        const text =
            block
                .replace(
                    /<script[\s\S]*?<\/script>/gi,
                    " "
                )
                .replace(
                    /<style[\s\S]*?<\/style>/gi,
                    " "
                )
                .replace(
                    /<[^>]+>/g,
                    " "
                )
                .replace(
                    /&nbsp;/gi,
                    " "
                )
                .replace(
                    /&amp;/gi,
                    "&"
                )
                .replace(
                    /\s+/g,
                    " "
                )
                .trim();

        if (imageUrl) {

            posts.push({
                id,
                imageUrl,
                text
            });

            log(
                `🖼 Пост #${id}: ${imageUrl.substring(
                    0,
                    150
                )}`
            );
        }
    }

    // Убираем дубли
    const unique =
        Array.from(
            new Map(
                posts.map(
                    post => [
                        post.id,
                        post
                    ]
                )
            ).values()
        );

    unique.sort(
        (a, b) =>
            b.id - a.id
    );

    return unique;
}

// ============================================================
// GET POSTS
// ============================================================

async function getLatestPosts() {

    const html =
        await getTelegramHTML();

    const posts =
        extractPosts(html);

    log(
        `📊 Найдено постов с картинками: ${posts.length}`
    );

    if (!posts.length) {
        throw new Error(
            "Telegram не вернул посты с изображениями"
        );
    }

    const latest =
        posts.slice(
            0,
            MAX_POSTS_TO_CHECK
        );

    log(
        `🆕 Последние посты: ${
            latest
                .map(x => "#" + x.id)
                .join(", ")
        }`
    );

    return latest;
}

// ============================================================
// DOWNLOAD IMAGE
// ============================================================

async function downloadImage(url) {

    if (!url) {
        throw new Error(
            "URL картинки отсутствует"
        );
    }

    if (
        !url.startsWith("http://") &&
        !url.startsWith("https://")
    ) {
        throw new Error(
            `Некорректный URL картинки: ${url}`
        );
    }

    log(
        `📥 Скачиваем: ${url.substring(
            0,
            200
        )}`
    );

    const response =
        await axios.get(
            url,
            {
                responseType:
                    "arraybuffer",

                timeout: 30000,

                maxContentLength:
                    20 * 1024 * 1024,

                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

                    Referer:
                        "https://t.me/"
                }
            }
        );

    const buffer =
        Buffer.from(
            response.data
        );

    log(
        `✅ Картинка скачана: ${buffer.length} байт`
    );

    return buffer;
}

// ============================================================
// PREPARE IMAGE
// ============================================================

async function prepareImage(buffer) {

    try {

        return await sharp(buffer)
            .rotate()
            .resize({
                width: 2200,
                withoutEnlargement: false
            })
            .grayscale()
            .normalize()
            .sharpen({
                sigma: 1
            })
            .png()
            .toBuffer();

    } catch (error) {

        log(
            `⚠️ Sharp: ${error.message}`
        );

        return buffer;
    }
}

// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer) {

    const prepared =
        await prepareImage(
            buffer
        );

    log(
        "🔍 Распознаём текст..."
    );

    const result =
        await Tesseract.recognize(
            prepared,
            "rus+eng",
            {
                logger: data => {

                    if (
                        data.status ===
                        "recognizing text"
                    ) {

                        const p =
                            Math.round(
                                (data.progress || 0) *
                                100
                            );

                        if (
                            p % 10 === 0
                        ) {
                            log(
                                `⏳ OCR: ${p}%`
                            );
                        }
                    }
                }
            }
        );

    return (
        result?.data?.text || ""
    );
}

// ============================================================
// PROCESS POST
// ============================================================

async function processPost(post) {

    log("");
    log(
        `📌 ПРОВЕРЯЕМ ПОСТ #${post.id}`
    );

    const image =
        await downloadImage(
            post.imageUrl
        );

    const text =
        await recognizeImage(
            image
        );

    const rates =
        extractRates(text);

    const count =
        countRates(rates);

    log(
        `📊 Пост #${post.id}: ${count}/9`
    );

    return {
        rates,
        text,
        count
    };
}

// ============================================================
// FETCH LATEST
// ============================================================

async function fetchLatestRates() {

    log("");
    log(
        "================================"
    );
    log(
        "🔄 ИЩЕМ НОВЫЕ КУРСЫ"
    );
    log(
        "================================"
    );

    const posts =
        await getLatestPosts();

    for (
        const post of posts
    ) {

        try {

            const result =
                await processPost(
                    post
                );

            if (
                validateRates(
                    result.rates
                )
            ) {

                log("");
                log(
                    "🎉 НОВЫЕ КУРСЫ ПОЛУЧЕНЫ!"
                );

                log(
                    `✅ Пост: #${post.id}`
                );

                log(
                    `✅ Курсов: ${result.count}/9`
                );

                return {
                    rates:
                        result.rates,

                    postId:
                        post.id,

                    text:
                        result.text
                };
            }

            log(
                `⚠️ Пост #${post.id}: курсов недостаточно`
            );

        } catch (error) {

            log(
                `❌ Пост #${post.id}: ${error.message}`
            );
        }
    }

    throw new Error(
        "Не найден новый пост с рабочими курсами"
    );
}

// ============================================================
// UPDATE
// ============================================================

async function updateRates(force = false) {

    if (
        updateInProgress
    ) {

        return {
            rates:
                cachedRates,

            post:
                cachedPost,

            source:
                "busy"
        };
    }

    const now =
        Date.now();

    if (
        !force &&
        cachedRates &&
        now - lastFetch <
            CACHE_TTL
    ) {

        log(
            "📦 Возвращаем данные из CACHE"
        );

        return {
            rates:
                cachedRates,

            post:
                cachedPost,

            source:
                "cache"
        };
    }

    updateInProgress = true;

    try {

        const result =
            await fetchLatestRates();

        cachedRates =
            result.rates;

        cachedPost =
            result.postId;

        cachedOcrText =
            result.text;

        lastFetch =
            Date.now();

        return {
            rates:
                cachedRates,

            post:
                cachedPost,

            source:
                "ocr"
        };

    } finally {

        updateInProgress =
            false;
    }
}

// ============================================================
// API
// ============================================================

app.get(
    "/api/rates",
    async (req, res) => {

        try {

            const result =
                await updateRates(
                    false
                );

            res.json({
                success: true,

                rates:
                    result.rates,

                post:
                    result.post,

                source:
                    result.source,

                updatedAt:
                    lastFetch
                        ? new Date(
                            lastFetch
                        ).toISOString()
                        : null
            });

        } catch (error) {

            log(
                "❌ API:",
                error.message
            );

            if (cachedRates) {

                return res.json({
                    success: true,

                    rates:
                        cachedRates,

                    post:
                        cachedPost,

                    source:
                        "stale-cache",

                    warning:
                        error.message
                });
            }

            res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// FORCE REFRESH
// ============================================================

app.get(
    "/api/rates/refresh",
    async (req, res) => {

        try {

            log(
                "🔄 FORCE REFRESH"
            );

            const result =
                await updateRates(
                    true
                );

            res.json({
                success: true,

                rates:
                    result.rates,

                post:
                    result.post,

                source:
                    "fresh-ocr",

                updatedAt:
                    new Date(
                        lastFetch
                    ).toISOString()
            });

        } catch (error) {

            log(
                "❌ Refresh:",
                error.message
            );

            res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// DEBUG
// ============================================================

app.get(
    "/api/debug/ocr",
    (req, res) => {

        res.json({
            post:
                cachedPost,

            rates:
                cachedRates,

            ocr:
                cachedOcrText
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({
            status:
                "ok",

            channel:
                CHANNEL,

            cached:
                !!cachedRates,

            post:
                cachedPost,

            updatedAt:
                lastFetch
                    ? new Date(
                        lastFetch
                    ).toISOString()
                    : null
        });
    }
);

// ============================================================
// HOME
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.send(`
            <html>
            <head>
                <meta charset="UTF-8">
                <title>LoyaltySwift OCR</title>
                <style>
                    body {
                        background:#07151b;
                        color:white;
                        font-family:Arial;
                        padding:30px;
                    }

                    a {
                        display:block;
                        padding:15px;
                        margin:10px 0;
                        background:#12313b;
                        color:#00d9ff;
                        text-decoration:none;
                        border-radius:8px;
                    }
                </style>
            </head>

            <body>

                <h1>🚀 LoyaltySwift OCR</h1>

                <a href="/api/rates">
                    💰 Текущие курсы
                </a>

                <a href="/api/rates/refresh">
                    🔄 Найти новый пост
                </a>

                <a href="/api/debug/ocr">
                    🔍 Последний OCR
                </a>

                <a href="/health">
                    ❤️ Health
                </a>

            </body>
            </html>
        `);
    }
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        log(
            "================================"
        );

        log(
            "🚀 SERVER STARTED"
        );

        log(
            `PORT: ${PORT}`
        );

        log(
            `CHANNEL: @${CHANNEL}`
        );

        log(
            `TELEGRAM: ${TELEGRAM_URL}`
        );

        log(
            "OCR: rus+eng"
        );

        log(
            "IMAGE PROCESSING: sharp"
        );

        log(
            "================================"
        );
    }
);
