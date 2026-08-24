const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// НАСТРОЙКИ
// ============================================================

const CHANNEL = process.env.TELEGRAM_CHANNEL || "LoyaltySwift";

const TELEGRAM_URL = `https://t.me/s/${CHANNEL}`;

// Как часто разрешаем автоматическое обновление.
// 30 секунд — достаточно быстро для сайта.
const UPDATE_INTERVAL = 30 * 1000;

// Сколько последних Telegram-постов смотреть.
const MAX_POSTS = 8;

// Минимальное количество распознанных курсов,
// чтобы считать картинку рабочей.
const MIN_RATES = 6;

// ============================================================
// СОСТОЯНИЕ СЕРВЕРА
// ============================================================

let state = {
    rates: null,

    postId: null,

    postUrl: null,

    ocrText: null,

    updatedAt: null,

    source: null,

    error: null,

    processing: false,

    lastCheck: null
};

// ============================================================
// EXPRESS
// ============================================================

app.use(cors());

app.use(
    express.json({
        limit: "1mb"
    })
);

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

function number(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    const result = Number(
        String(value)
            .replace(/\s/g, "")
            .replace(",", ".")
            .trim()
    );

    return Number.isFinite(result)
        ? result
        : null;
}

// ============================================================
// RATE COUNT
// ============================================================

function countRates(rates) {

    if (!rates) {
        return 0;
    }

    return Object.values(rates)
        .filter(
            value =>
                value !== null &&
                Number.isFinite(value)
        )
        .length;
}

// ============================================================
// NORMALIZE OCR
// ============================================================

function normalizeOCR(text) {

    let result = String(text || "");

    result = result
        .replace(/\r/g, "\n")

        // тире
        .replace(/[–—−]/g, "-")

        // OCR часто путает эти символы
        .replace(/\bU5D\b/gi, "USD")
        .replace(/\bUSO\b/gi, "USD")
        .replace(/\bUsD\b/g, "USD")
        .replace(/\bU5D\b/g, "USD")

        // JPY
        .replace(/\bJpY\b/g, "JPY")
        .replace(/\bJPV\b/gi, "JPY")
        .replace(/\bJY\b/gi, "JPY")
        .replace(/\b13PY\b/gi, "JPY")
        .replace(/\bI3PY\b/gi, "JPY")
        .replace(/\bIJPY\b/gi, "JPY")
        .replace(/\bI3PY\b/gi, "JPY")

        // KRW
        .replace(/\bKRVV\b/gi, "KRW")
        .replace(/\bKRV\b/gi, "KRW")
        .replace(/\bKRVV\b/gi, "KRW")

        // AED
        .replace(/\bAЕD\b/gi, "AED")
        .replace(/\bАЕD\b/gi, "AED")
        .replace(/\bАЕр\b/gi, "AED")
        .replace(/\bАЕР\b/gi, "AED")
        .replace(/\bAЕр\b/gi, "AED")

        // THB
        .replace(/\bTH8\b/gi, "THB")
        .replace(/\bTHВ\b/gi, "THB")
        .replace(/\bTНB\b/gi, "THB")
        .replace(/\bтнв\b/gi, "THB")

        // CNY
        .replace(/\b1eNy\b/gi, "1 CNY")
        .replace(/\beNy\b/gi, "CNY")
        .replace(/\bENY\b/g, "CNY")
        .replace(/\beNY\b/g, "CNY")
        .replace(/\bCnY\b/g, "CNY")
        .replace(/\bCNU\b/gi, "CNY")
        .replace(/\bCNV\b/gi, "CNY")

        // IDUBID
        .replace(/IDUBlD/gi, "IDUBID")
        .replace(/IDUB1D/gi, "IDUBID");

    return result;
}

// ============================================================
// ПОЛУЧЕНИЕ КУРСОВ ИЗ OCR
// ============================================================

function extractRates(rawText) {

    const text = normalizeOCR(rawText);

    const lines = text
        .split("\n")
        .map(line => line.trim())
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

    const usdValues = [];

    for (const line of lines) {

        const match = line.match(
            /\b1?\s*USD\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        const value = number(match[1]);

        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            usdValues.push({
                value,
                line
            });
        }
    }

    if (usdValues.length > 0) {

        rates.USD =
            usdValues[0].value;
    }

    // IDUBID обычно второй USD
    for (const item of usdValues) {

        if (
            /IDUBID/i.test(item.line)
        ) {

            rates.USD_IDUBID =
                item.value;
        }
    }

    if (
        rates.USD_IDUBID === null &&
        usdValues.length >= 2
    ) {

        rates.USD_IDUBID =
            usdValues[1].value;
    }

    // ========================================================
    // KRW
    // ========================================================

    for (const line of lines) {

        const match = line.match(
            /1000\s*KRW\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        const value =
            number(match[1]);

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

        const match = line.match(
            /1\s*AED\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        const value =
            number(match[1]);

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

        const match = line.match(
            /1\s*THB\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        const value =
            number(match[1]);

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

        const match = line.match(
            /1\s*CNY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        let value =
            number(match[1]);

        if (
            value !== null &&
            value > 100
        ) {

            value =
                value / 100;
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

        const match = line.match(
            /100\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        const value =
            number(match[1]);

        if (
            value >= 10 &&
            value <= 100
        ) {

            rates.JPY_SWIFT =
                value;

            break;
        }
    }

    // ========================================================
    // AFA TRADING
    // ========================================================

    const afaValues = [];

    for (const line of lines) {

        const match = line.match(
            /1\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        let value =
            number(match[1]);

        if (
            value !== null &&
            value > 1000
        ) {

            value =
                value / 100;
        }

        if (
            value >= 10 &&
            value <= 100
        ) {

            afaValues.push(value);
        }
    }

    // Удаляем дубликаты
    const uniqueAfa =
        [...new Set(afaValues)];

    if (
        uniqueAfa.length >= 1
    ) {

        rates.JPY_AFA_CASH =
            uniqueAfa[0];
    }

    if (
        uniqueAfa.length >= 2
    ) {

        rates.JPY_AFA_QR =
            uniqueAfa[1];
    }

    // ========================================================
    // СПЕЦИАЛЬНО ДЛЯ OCR:
    //
    // 1зРу=56.10
    //
    // после normalize может всё равно остаться мусор.
    // Поэтому отдельный поиск по строке.
    // ========================================================

    if (
        rates.JPY_AFA_CASH === null ||
        rates.JPY_AFA_QR === null
    ) {

        for (const line of lines) {

            const match =
                line.match(
                    /1\s*[^\d\sA-ZА-Я]{0,3}\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/i
                );

            if (!match) {
                continue;
            }

            let value =
                number(match[1]);

            if (
                value > 1000
            ) {

                value =
                    value / 100;
            }

            if (
                value >= 10 &&
                value <= 100
            ) {

                if (
                    rates.JPY_AFA_CASH === null
                ) {

                    rates.JPY_AFA_CASH =
                        value;
                }
                else if (
                    rates.JPY_AFA_QR === null &&
                    value !==
                        rates.JPY_AFA_CASH
                ) {

                    rates.JPY_AFA_QR =
                        value;
                }
            }
        }
    }

    // ========================================================
    // ЛОГ
    // ========================================================

    console.log("");
    console.log(
        "========== OCR TEXT =========="
    );
    console.log(text);
    console.log(
        "=============================="
    );

    console.log(
        "💰 RESULT:",
        JSON.stringify(
            rates,
            null,
            2
        )
    );

    console.log(
        `📊 Найдено курсов: ${countRates(rates)}/9`
    );

    return rates;
}

// ============================================================
// ПРОВЕРКА КУРСОВ
// ============================================================

function validateRates(rates) {

    if (!rates) {
        return false;
    }

    const count =
        countRates(rates);

    // USD обязателен
    if (
        rates.USD === null
    ) {
        return false;
    }

    // JPY SWIFT обязателен
    if (
        rates.JPY_SWIFT === null
    ) {
        return false;
    }

    // минимум 6 курсов
    if (
        count < MIN_RATES
    ) {
        return false;
    }

    return true;
}

// ============================================================
// TELEGRAM HTML
// ============================================================

async function getTelegramHTML() {

    const response =
        await axios.get(
            TELEGRAM_URL,
            {
                timeout: 20000,

                responseType: "text",

                headers: {

                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

                    "Accept":
                        "text/html,application/xhtml+xml",

                    "Accept-Language":
                        "ru-RU,ru;q=0.9,en;q=0.8"
                }
            }
        );

    return response.data;
}

// ============================================================
// CLEAN URL
// ============================================================

function cleanUrl(value) {

    if (!value) {
        return null;
    }

    let url =
        String(value)
            .trim()
            .replace(/^["']/, "")
            .replace(/["']$/, "");

    url =
        url
            .replace(/&amp;/g, "&")
            .replace(/&#38;/g, "&")
            .replace(/\\\//g, "/");

    if (
        url.startsWith("https://")
    ) {
        return url;
    }

    if (
        url.startsWith("http://")
    ) {
        return url;
    }

    if (
        url.startsWith("//")
    ) {
        return "https:" + url;
    }

    return null;
}

// ============================================================
// ПОИСК ПОСТОВ
// ============================================================

function parsePosts(html) {

    const posts = [];

    /*
       Находим каждый data-post.

       Например:

       data-post="LoyaltySwift/1340"
    */

    const regex =
        /data-post=["']LoyaltySwift\/(\d+)["']/gi;

    let match;

    while (
        (match = regex.exec(html))
    ) {

        const id =
            Number(match[1]);

        /*
           Берём достаточно большой участок
           вокруг конкретного поста.
        */

        const start =
            Math.max(
                0,
                match.index - 3000
            );

        const end =
            Math.min(
                html.length,
                match.index + 25000
            );

        const block =
            html.substring(
                start,
                end
            );

        let imageUrl = null;

        // ====================================================
        // background-image
        // ====================================================

        const backgrounds =
            block.match(
                /background-image\s*:\s*url\((.*?)\)/gis
            );

        if (
            backgrounds
        ) {

            for (
                const bg of backgrounds
            ) {

                const inside =
                    bg
                        .replace(
                            /^.*?url\(/is,
                            ""
                        )
                        .replace(
                            /\)$/is,
                            ""
                        )
                        .trim();

                const candidate =
                    cleanUrl(
                        inside
                    );

                if (
                    candidate
                ) {

                    imageUrl =
                        candidate;

                    break;
                }
            }
        }

        // ====================================================
        // style url
        // ====================================================

        if (
            !imageUrl
        ) {

            const style =
                block.match(
                    /url\(["']?(https?:\/\/[^"')\s]+)["']?\)/i
                );

            if (
                style
            ) {

                imageUrl =
                    cleanUrl(
                        style[1]
                    );
            }
        }

        // ====================================================
        // IMG SRC
        // ====================================================

        if (
            !imageUrl
        ) {

            const img =
                block.match(
                    /<img[^>]+src=["']([^"']+)["']/i
                );

            if (
                img
            ) {

                imageUrl =
                    cleanUrl(
                        img[1]
                    );
            }
        }

        if (
            imageUrl
        ) {

            posts.push({

                id,

                imageUrl,

                postUrl:
                    `https://t.me/${CHANNEL}/${id}`
            });
        }
    }

    // удаляем дубли

    const unique =
        new Map();

    for (
        const post of posts
    ) {

        unique.set(
            post.id,
            post
        );
    }

    const result =
        [...unique.values()];

    result.sort(
        (a, b) =>
            b.id - a.id
    );

    return result;
}

// ============================================================
// ПОИСК ПОСЛЕДНИХ ПОСТОВ
// ============================================================

async function getLatestPosts() {

    log(
        "🌐 Загружаем Telegram..."
    );

    const html =
        await getTelegramHTML();

    const posts =
        parsePosts(html);

    log(
        `📰 Найдено постов: ${posts.length}`
    );

    const latest =
        posts.slice(
            0,
            MAX_POSTS
        );

    log(
        "🆕 Последние:",
        latest
            .map(
                post =>
                    `#${post.id}`
            )
            .join(", ")
    );

    return latest;
}

// ============================================================
// DOWNLOAD
// ============================================================

async function downloadImage(url) {

    if (
        !url ||
        !/^https?:\/\//i.test(url)
    ) {

        throw new Error(
            "Некорректный URL изображения"
        );
    }

    log(
        "📥 Скачиваем изображение..."
    );

    const response =
        await axios.get(
            url,
            {
                responseType:
                    "arraybuffer",

                timeout:
                    30000,

                maxContentLength:
                    20 * 1024 * 1024,

                headers: {

                    "User-Agent":
                        "Mozilla/5.0 Chrome/131 Safari/537.36",

                    "Referer":
                        "https://t.me/"
                }
            }
        );

    const buffer =
        Buffer.from(
            response.data
        );

    log(
        `✅ Получено ${buffer.length} байт`
    );

    return buffer;
}

// ============================================================
// PREPARE IMAGE
// ============================================================

async function prepareImage(buffer) {

    return sharp(buffer)
        .rotate()
        .resize({
            width: 2000,

            height: 3000,

            fit: "inside",

            withoutEnlargement: false
        })
        .grayscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
}

// ============================================================
// OCR
// ============================================================

async function runOCR(buffer) {

    log(
        "🔍 Запускаем OCR..."
    );

    const prepared =
        await prepareImage(
            buffer
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

                        const percent =
                            Math.round(
                                (data.progress || 0) *
                                100
                            );

                        if (
                            percent % 20 === 0
                        ) {

                            log(
                                `⏳ OCR ${percent}%`
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
// ОБРАБОТКА ПОСТА
// ============================================================

async function processPost(post) {

    log("");
    log(
        `📌 Проверяем #${post.id}`
    );

    const image =
        await downloadImage(
            post.imageUrl
        );

    const text =
        await runOCR(
            image
        );

    const rates =
        extractRates(
            text
        );

    const count =
        countRates(
            rates
        );

    log(
        `📊 #${post.id}: ${count}/9`
    );

    return {
        rates,
        text,
        count
    };
}

// ============================================================
// ОСНОВНОЙ REFRESH
// ============================================================

async function refreshRates(
    force = false
) {

    if (
        state.processing
    ) {

        log(
            "⏳ Обновление уже выполняется"
        );

        return;
    }

    if (
        !force &&
        state.updatedAt
    ) {

        const age =
            Date.now() -
            new Date(
                state.updatedAt
            ).getTime();

        if (
            age <
            UPDATE_INTERVAL
        ) {

            return;
        }
    }

    state.processing =
        true;

    state.lastCheck =
        new Date().toISOString();

    try {

        const posts =
            await getLatestPosts();

        if (
            !posts.length
        ) {

            throw new Error(
                "Посты Telegram не найдены"
            );
        }

        /*
           ВАЖНО:

           Если уже есть пост #1340,
           и Telegram снова показывает #1340,
           мы всё равно можем проверить его,
           если force=true.

           Для автоматического режима
           сначала пробуем самый новый пост.
        */

        let selected = null;

        for (
            const post of posts
        ) {

            /*
               Если это уже обработанный пост
               и есть свежий результат,
               можно не делать OCR повторно.
            */

            if (
                !force &&
                state.postId !== null &&
                post.id <=
                    Number(state.postId)
            ) {

                continue;
            }

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

                    selected = {

                        post,

                        result
                    };

                    break;
                }

                log(
                    `⚠️ #${post.id} пропущен: недостаточно курсов`
                );

            } catch (error) {

                log(
                    `❌ #${post.id}: ${error.message}`
                );
            }
        }

        /*
           Если нового поста нет,
           возвращаем старые курсы.
        */

        if (
            !selected
        ) {

            if (
                state.rates
            ) {

                log(
                    "ℹ️ Нового подходящего поста нет"
                );

                state.source =
                    "unchanged";

                state.processing =
                    false;

                return;
            }

            /*
               Первый запуск.

               Если по какой-то причине
               пост имеет ID меньше/равен старому
               (например после перезапуска Render),
               проверяем самый свежий.
            */

            const first =
                posts[0];

            log(
                `🔁 Первый запуск: проверяем #${first.id}`
            );

            const result =
                await processPost(
                    first
                );

            if (
                !validateRates(
                    result.rates
                )
            ) {

                throw new Error(
                    `Свежий пост #${first.id} не прошёл проверку`
                );
            }

            selected = {

                post: first,

                result
            };
        }

        // ====================================================
        // СОХРАНЯЕМ
        // ====================================================

        state.rates =
            selected.result.rates;

        state.postId =
            selected.post.id;

        state.postUrl =
            selected.post.postUrl;

        state.ocrText =
            selected.result.text;

        state.updatedAt =
            new Date().toISOString();

        state.source =
            "ocr";

        state.error =
            null;

        log("");
        log(
            "🎉 НОВЫЕ КУРСЫ!"
        );

        log(
            `📌 Пост #${state.postId}`
        );

        log(
            `📊 Курсов: ${countRates(
                state.rates
            )}/9`
        );

    } catch (error) {

        state.error =
            error.message;

        log(
            "❌ REFRESH:",
            error.message
        );

        /*
           Старые курсы НЕ удаляем.
        */

    } finally {

        state.processing =
            false;
    }
}

// ============================================================
// API /rates
// ============================================================

app.get(
    "/api/rates",
    async (req, res) => {

        /*
           Если данных ещё нет —
           ждём первый OCR.

           Если данные уже есть —
           сразу отдаём сайтy,
           а обновление запускаем отдельно.
        */

        if (
            !state.rates
        ) {

            await refreshRates(
                true
            );

        } else {

            refreshRates(
                false
            ).catch(
                error =>
                    log(
                        "Background:",
                        error.message
                    )
            );
        }

        res.json({

            success:
                !!state.rates,

            rates:
                state.rates,

            post:
                state.postId,

            postUrl:
                state.postUrl,

            updatedAt:
                state.updatedAt,

            source:
                state.source,

            processing:
                state.processing,

            error:
                state.error
        });
    }
);

// ============================================================
// FORCE REFRESH
// ============================================================

app.get(
    "/api/rates/refresh",
    async (req, res) => {

        await refreshRates(
            true
        );

        res.json({

            success:
                !!state.rates,

            rates:
                state.rates,

            post:
                state.postId,

            postUrl:
                state.postUrl,

            updatedAt:
                state.updatedAt,

            source:
                state.source,

            processing:
                state.processing,

            error:
                state.error
        });
    }
);

// ============================================================
// STATUS
// ============================================================

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            online:
                true,

            channel:
                CHANNEL,

            telegram:
                TELEGRAM_URL,

            post:
                state.postId,

            updatedAt:
                state.updatedAt,

            processing:
                state.processing,

            ratesCount:
                countRates(
                    state.rates
                ),

            error:
                state.error
        });
    }
);

// ============================================================
// DEBUG OCR
// ============================================================

app.get(
    "/api/debug",
    (req, res) => {

        res.json({

            post:
                state.postId,

            postUrl:
                state.postUrl,

            rates:
                state.rates,

            ocr:
                state.ocrText,

            updatedAt:
                state.updatedAt,

            error:
                state.error
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.status(200).json({
            status: "ok"
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
<!DOCTYPE html>

<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>OCR Rates API</title>

<style>

body {
    margin: 0;
    padding: 30px;
    background: #08151c;
    color: white;
    font-family: Arial, sans-serif;
}

.container {
    max-width: 700px;
    margin: auto;
}

.card {
    background: #10242d;
    border-radius: 15px;
    padding: 25px;
    margin-bottom: 20px;
}

a {
    display: block;
    background: #153641;
    color: #43d9ff;
    text-decoration: none;
    padding: 15px;
    border-radius: 10px;
    margin-top: 10px;
}

a:hover {
    background: #1b4654;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>💰 LoyaltySwift Rates</h1>

<p>
Backend работает.
</p>

<p>
Канал:
<b>@${CHANNEL}</b>
</p>

</div>

<div class="card">

<a href="/api/rates">
💰 Получить курсы
</a>

<a href="/api/rates/refresh">
🔄 Принудительно найти новый пост
</a>

<a href="/api/status">
📊 Статус сервера
</a>

<a href="/api/debug">
🔍 Последний OCR
</a>

<a href="/health">
❤️ Health
</a>

</div>

</div>

</body>

</html>
        `);
    }
);

// ============================================================
// AUTO CHECK
// ============================================================

setInterval(
    () => {

        if (
            state.rates &&
            !state.processing
        ) {

            refreshRates(
                false
            ).catch(
                error =>
                    log(
                        "Auto update:",
                        error.message
                    )
            );
        }

    },
    UPDATE_INTERVAL
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        log(
            "=========================================="
        );

        log(
            "🚀 LOYALTY SWIFT RATES SERVER"
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
            "AUTO UPDATE: 30 sec"
        );

        log(
            "OCR: rus+eng"
        );

        log(
            "IMAGE PROCESSING: sharp"
        );

        log(
            "=========================================="
        );
    }
);
