const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL = "LoyaltySwift";
const TELEGRAM_URL = `https://t.me/s/${CHANNEL}`;

// ============================================================
// НАСТРОЙКИ
// ============================================================

const CACHE_TTL = 2 * 60 * 1000;

// Сколько последних постов разрешаем проверять
const MAX_POSTS_TO_CHECK = 10;

// Минимальное количество найденных курсов,
// чтобы считать картинку рабочей
const MIN_RATES_REQUIRED = 6;

// Таймауты
const TELEGRAM_TIMEOUT = 20000;
const IMAGE_TIMEOUT = 30000;

// ============================================================
// EXPRESS
// ============================================================

app.use(cors());
app.use(express.json());

// ============================================================
// CACHE
// ============================================================

let cachedRates = null;
let cachedPost = null;
let cachedOcrText = null;
let lastFetch = 0;

// Чтобы одновременно не запускать несколько OCR
let updateInProgress = false;

// ============================================================
// LOG
// ============================================================

function log(message, ...args) {
    console.log(
        `[${new Date().toISOString()}] ${message}`,
        ...args
    );
}

// ============================================================
// ЧИСЛО
// ============================================================

function toNumber(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const cleaned = String(value)
        .trim()
        .replace(/\s/g, "")
        .replace(",", ".");

    const number = Number(cleaned);

    return Number.isFinite(number) ? number : null;
}

// ============================================================
// НОРМАЛИЗАЦИЯ ЧИСЛА
// ============================================================

function normalizeJPY(value) {
    let number = toNumber(value);

    if (number === null) {
        return null;
    }

    // OCR может прочитать:
    // 1 JPY = 5580
    //
    // На картинке фактически:
    // 1 JPY = 55.80

    if (number >= 1000 && number <= 10000) {
        number = number / 100;
    }

    return number;
}

// ============================================================
// НОРМАЛИЗАЦИЯ OCR ТЕКСТА
// ============================================================

function normalizeOCR(text) {
    let result = String(text || "");

    // Переносы
    result = result.replace(/\r/g, "\n");

    // Типографские символы
    result = result.replace(/[–—−]/g, "-");
    result = result.replace(/[，]/g, ",");

    // ========================================================
    // USD
    // ========================================================

    result = result
        .replace(/\bU5D\b/gi, "USD")
        .replace(/\bUSO\b/gi, "USD")
        .replace(/\bUsD\b/g, "USD")
        .replace(/\bU\$D\b/gi, "USD");

    // ========================================================
    // JPY
    // ========================================================

    result = result
        .replace(/\bJpY\b/g, "JPY")
        .replace(/\bJPV\b/gi, "JPY")
        .replace(/\bJY\b/gi, "JPY")
        .replace(/\b13PY\b/gi, "JPY")
        .replace(/\bI3PY\b/gi, "JPY")
        .replace(/\bIJPY\b/gi, "JPY")
        .replace(/\bJ3Y\b/gi, "JPY");

    // ========================================================
    // KRW
    // ========================================================

    result = result
        .replace(/\bKRVV\b/gi, "KRW")
        .replace(/\bKRV\b/gi, "KRW");

    // ========================================================
    // CNY
    // ========================================================

    // Очень важный случай из твоего OCR:
    //
    // 1eNy = 1315
    //
    // Превращаем eNy -> CNY

    result = result
        .replace(/\beNy\b/g, "CNY")
        .replace(/\bENY\b/g, "CNY")
        .replace(/\beNY\b/g, "CNY")
        .replace(/\bCnY\b/g, "CNY")
        .replace(/\bCNU\b/gi, "CNY")
        .replace(/\bCNV\b/gi, "CNY");

    // Иногда OCR видит первую букву как цифру
    result = result.replace(/\b1eNy\b/gi, "1 CNY");
    result = result.replace(/\b1ENY\b/gi, "1 CNY");

    // ========================================================
    // THB
    // ========================================================

    result = result
        .replace(/\bTH8\b/gi, "THB")
        .replace(/\bTHВ\b/gi, "THB")
        .replace(/\bTНB\b/gi, "THB")
        .replace(/\bтнв\b/gi, "THB")
        .replace(/\bтн8\b/gi, "THB");

    // ========================================================
    // AED
    // ========================================================

    result = result
        .replace(/\bAЕD\b/gi, "AED")
        .replace(/\bАЕD\b/gi, "AED")
        .replace(/\bАЕр\b/gi, "AED")
        .replace(/\bАЕР\b/gi, "AED")
        .replace(/\bAЕр\b/gi, "AED")
        .replace(/\bAEP\b/gi, "AED");

    // ========================================================
    // IDUBID
    // ========================================================

    result = result
        .replace(/IDUBlD/gi, "IDUBID")
        .replace(/IDUB1D/gi, "IDUBID")
        .replace(/IDUBID/gi, "IDUBID");

    // Убираем лишние пробелы
    result = result
        .split("\n")
        .map(line => line.replace(/[ \t]+/g, " ").trim())
        .join("\n");

    return result;
}

// ============================================================
// ПОЛУЧЕНИЕ ЧИСЕЛ ИЗ СТРОКИ
// ============================================================

function getNumbers(text) {
    const matches = String(text).match(
        /\d+(?:[.,]\d+)?/g
    );

    if (!matches) {
        return [];
    }

    return matches
        .map(toNumber)
        .filter(v => v !== null);
}

// ============================================================
// ПОИСК КУРСА В ОКРЕСТНОСТИ
// ============================================================

function findRate(text, regex, min, max) {
    const match = text.match(regex);

    if (!match) {
        return null;
    }

    const value = toNumber(match[1]);

    if (value === null) {
        return null;
    }

    if (value < min || value > max) {
        return null;
    }

    return value;
}

// ============================================================
// ИЗВЛЕЧЕНИЕ КУРСОВ
// ============================================================

function extractRates(rawText) {
    const text = normalizeOCR(rawText);

    console.log("");
    console.log("========== NORMALIZED OCR ==========");
    console.log(text);
    console.log("====================================");
    console.log("");

    const lines = text
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

    // ========================================================
    // РЕЗУЛЬТАТ
    // ========================================================

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

    const usdEntries = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const match = line.match(
            /\b1?\s*USD\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = toNumber(match[1]);

        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {
            usdEntries.push({
                value,
                index: i,
                line
            });
        }
    }

    // Первый USD
    if (usdEntries.length > 0) {
        rates.USD = usdEntries[0].value;
    }

    // Если строка содержит IDUBID
    for (const entry of usdEntries) {
        if (/IDUBID/i.test(entry.line)) {
            rates.USD_IDUBID = entry.value;
        }
    }

    // Проверяем несколько строк вокруг IDUBID
    if (rates.USD_IDUBID === null) {
        for (let i = 0; i < lines.length; i++) {
            if (!/IDUBID/i.test(lines[i])) {
                continue;
            }

            for (
                let j = Math.max(0, i - 2);
                j <= Math.min(lines.length - 1, i + 3);
                j++
            ) {
                const match = lines[j].match(
                    /\b1?\s*USD\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
                );

                if (!match) {
                    continue;
                }

                const value = toNumber(match[1]);

                if (
                    value !== null &&
                    value >= 50 &&
                    value <= 150
                ) {
                    rates.USD_IDUBID = value;
                    break;
                }
            }

            if (rates.USD_IDUBID !== null) {
                break;
            }
        }
    }

    // Если найдено два USD
    if (
        rates.USD_IDUBID === null &&
        usdEntries.length >= 2
    ) {
        rates.USD_IDUBID =
            usdEntries[1].value;
    }

    // ========================================================
    // KRW
    // ========================================================

    for (const line of lines) {
        const match = line.match(
            /1000\s*KRW\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = toNumber(match[1]);

        if (
            value !== null &&
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
            /1\s*AED\s*=?\s*(\d{1,2}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = toNumber(match[1]);

        if (
            value !== null &&
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
            /1\s*THB\s*=?\s*(\d{1,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = toNumber(match[1]);

        if (
            value !== null &&
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

    /*
        Основной случай:

        1 CNY = 13.15

        OCR случай:

        1eNy = 1315

        После normalizeOCR:

        1 CNY = 1315
    */

    for (const line of lines) {
        const match = line.match(
            /1\s*CNY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        let value = toNumber(match[1]);

        if (value === null) {
            continue;
        }

        // 1315 -> 13.15
        if (
            value >= 100 &&
            value <= 10000
        ) {
            value = value / 100;
        }

        if (
            value >= 1 &&
            value <= 30
        ) {
            rates.CNY = value;
            break;
        }
    }

    // Дополнительный CNY fallback
    if (rates.CNY === null) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!/КИТАЙ|CNY/i.test(line)) {
                continue;
            }

            // Проверяем текущую и следующие строки
            for (
                let j = i;
                j <= Math.min(i + 2, lines.length - 1);
                j++
            ) {
                const numbers = getNumbers(lines[j]);

                for (const original of numbers) {
                    let value = original;

                    if (
                        value >= 100 &&
                        value <= 10000
                    ) {
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

                if (rates.CNY !== null) {
                    break;
                }
            }

            if (rates.CNY !== null) {
                break;
            }
        }
    }

    // ========================================================
    // JPY SWIFT
    // ========================================================

    for (const line of lines) {
        const match = line.match(
            /100\s*JPY\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = toNumber(match[1]);

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {
            rates.JPY_SWIFT = value;
            break;
        }
    }

    // ========================================================
    // JPY AFA
    // ========================================================

    /*
        ВАЖНО.

        На твоей картинке:

        AFA TRADING        AFA TRADING

        1JPY = 5580        13PY = 55.30

        После исправления OCR:

        1JPY = 5580        1JPY = 55.30

        Нужно получить:

        CASH = 55.80
        QR   = 55.30
    */

    const afaCandidates = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!/JPY/i.test(line)) {
            continue;
        }

        const match = line.match(
            /1\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

        if (!match) {
            continue;
        }

        let value = normalizeJPY(match[1]);

        if (
            value === null ||
            value < 10 ||
            value > 100
        ) {
            continue;
        }

        afaCandidates.push({
            index: i,
            value,
            line
        });
    }

    // ========================================================
    // AFA CASH
    // ========================================================

    /*
        Ищем слово AFA + ближайший JPY.
    */

    let cashIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (
            /AFA/i.test(lines[i]) &&
            !/QR/i.test(lines[i])
        ) {
            cashIndex = i;
            break;
        }
    }

    if (cashIndex !== -1) {
        for (const candidate of afaCandidates) {
            if (
                candidate.index >= cashIndex &&
                candidate.index <= cashIndex + 3
            ) {
                rates.JPY_AFA_CASH =
                    candidate.value;
                break;
            }
        }
    }

    // ========================================================
    // AFA QR
    // ========================================================

    /*
        Ищем QR отдельно.
    */

    let qrIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (/QR/i.test(lines[i])) {
            qrIndex = i;
            break;
        }
    }

    if (qrIndex !== -1) {
        for (const candidate of afaCandidates) {
            if (
                candidate.index >= qrIndex &&
                candidate.index <= qrIndex + 3
            ) {
                rates.JPY_AFA_QR =
                    candidate.value;
                break;
            }
        }
    }

    // ========================================================
    // ЕСЛИ OCR НЕ УВИДЕЛ QR
    // ========================================================

    /*
        Используем расположение кандидатов.

        В нормальной картинке AFA идут:

        55.80
        55.30

        Поэтому второй кандидат = QR.
    */

    if (
        rates.JPY_AFA_CASH === null &&
        afaCandidates.length >= 1
    ) {
        rates.JPY_AFA_CASH =
            afaCandidates[0].value;
    }

    if (
        rates.JPY_AFA_QR === null &&
        afaCandidates.length >= 2
    ) {
        /*
            Если CASH уже найден как первый,
            QR должен быть следующим курсом.
        */

        if (
            rates.JPY_AFA_CASH !== null
        ) {
            for (
                const candidate of afaCandidates
            ) {
                if (
                    candidate.value !==
                    rates.JPY_AFA_CASH
                ) {
                    rates.JPY_AFA_QR =
                        candidate.value;
                    break;
                }
            }
        } else {
            rates.JPY_AFA_QR =
                afaCandidates[1].value;
        }
    }

    // ========================================================
    // ЕСЛИ QR И CASH ОДИНАКОВЫЕ
    // ========================================================

    /*
        В твоём предыдущем результате:

        CASH = 55.8
        QR   = 55.8

        Хотя в OCR были:

        55.80
        55.30

        Поэтому если найдено два разных JPY,
        обязательно используем второй для QR.
    */

    if (
        rates.JPY_AFA_CASH !== null &&
        rates.JPY_AFA_QR ===
            rates.JPY_AFA_CASH &&
        afaCandidates.length >= 2
    ) {
        const second =
            afaCandidates.find(
                candidate =>
                    candidate.value !==
                    rates.JPY_AFA_CASH
            );

        if (second) {
            rates.JPY_AFA_QR =
                second.value;
        }
    }

    // ========================================================
    // ФИНАЛ
    // ========================================================

    const count =
        Object.values(rates)
            .filter(
                value =>
                    value !== null &&
                    Number.isFinite(value)
            )
            .length;

    console.log("");
    console.log(
        "💰 РЕЗУЛЬТАТ OCR:"
    );

    console.log(
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
// ПРОВЕРКА КУРСОВ
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
// ПРОВЕРКА РЕАЛЬНОСТИ КУРСОВ
// ============================================================

function validateRates(rates) {
    if (!rates) {
        return false;
    }

    if (
        rates.USD !== null &&
        (rates.USD < 50 || rates.USD > 150)
    ) {
        return false;
    }

    if (
        rates.USD_IDUBID !== null &&
        (
            rates.USD_IDUBID < 50 ||
            rates.USD_IDUBID > 150
        )
    ) {
        return false;
    }

    if (
        rates.JPY_SWIFT !== null &&
        (
            rates.JPY_SWIFT < 10 ||
            rates.JPY_SWIFT > 100
        )
    ) {
        return false;
    }

    if (
        rates.JPY_AFA_CASH !== null &&
        (
            rates.JPY_AFA_CASH < 10 ||
            rates.JPY_AFA_CASH > 100
        )
    ) {
        return false;
    }

    if (
        rates.JPY_AFA_QR !== null &&
        (
            rates.JPY_AFA_QR < 10 ||
            rates.JPY_AFA_QR > 100
        )
    ) {
        return false;
    }

    if (
        rates.KRW !== null &&
        (
            rates.KRW < 10 ||
            rates.KRW > 100
        )
    ) {
        return false;
    }

    if (
        rates.AED !== null &&
        (
            rates.AED < 5 ||
            rates.AED > 50
        )
    ) {
        return false;
    }

    if (
        rates.CNY !== null &&
        (
            rates.CNY < 1 ||
            rates.CNY > 30
        )
    ) {
        return false;
    }

    if (
        rates.THB !== null &&
        (
            rates.THB < 0.1 ||
            rates.THB > 10
        )
    ) {
        return false;
    }

    return countRates(rates) >= MIN_RATES_REQUIRED;
}

// ============================================================
// TELEGRAM
// ============================================================

async function getTelegramHTML() {
    log("🌐 Загружаем Telegram...");

    const response = await axios.get(
        TELEGRAM_URL,
        {
            timeout: TELEGRAM_TIMEOUT,
            responseType: "text",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",

                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",

                "Accept-Language":
                    "ru-RU,ru;q=0.9,en;q=0.8"
            }
        }
    );

    return response.data;
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ПОСТОВ
// ============================================================

function extractPosts(html) {
    const posts = [];

    const idRegex =
        /data-post=["']LoyaltySwift\/(\d+)["']/gi;

    const matches = [];

    let match;

    while (
        (match = idRegex.exec(html)) !== null
    ) {
        const id = Number(match[1]);

        if (!matches.includes(id)) {
            matches.push(id);
        }
    }

    log(
        `🔎 Telegram ID найдено: ${matches.length}`
    );

    for (const id of matches) {
        const marker =
            `LoyaltySwift/${id}`;

        const position =
            html.indexOf(marker);

        if (position === -1) {
            continue;
        }

        // Берём достаточно большой блок
        const block =
            html.substring(
                Math.max(0, position - 3000),
                Math.min(
                    html.length,
                    position + 25000
                )
            );

        // ====================================================
        // IMAGE
        // ====================================================

        let imageUrl = null;

        const bgMatch =
            block.match(
                /background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/i
            );

        if (bgMatch) {
            imageUrl = bgMatch[1];
        }

        // Другой вариант Telegram
        if (!imageUrl) {
            const imgMatch =
                block.match(
                    /<img[^>]+src=["']([^"']+)["']/i
                );

            if (imgMatch) {
                imageUrl = imgMatch[1];
            }
        }

        if (imageUrl) {
            imageUrl = imageUrl
                .replace(/&amp;/g, "&")
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/");
        }

        if (!imageUrl) {
            continue;
        }

        // ====================================================
        // TEXT
        // ====================================================

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

        posts.push({
            id,
            imageUrl,
            text
        });
    }

    // Убираем дубли
    const unique = [];
    const used = new Set();

    for (const post of posts) {
        if (used.has(post.id)) {
            continue;
        }

        used.add(post.id);
        unique.push(post);
    }

    // Самый новый первым
    unique.sort(
        (a, b) => b.id - a.id
    );

    return unique;
}

// ============================================================
// ПОСЛЕДНИЕ ПОСТЫ
// ============================================================

async function getLatestPosts() {
    const html =
        await getTelegramHTML();

    const posts =
        extractPosts(html);

    log(
        `📊 Найдено постов с картинками: ${posts.length}`
    );

    if (posts.length === 0) {
        throw new Error(
            "Не найдено постов с изображениями"
        );
    }

    const latest =
        posts.slice(
            0,
            MAX_POSTS_TO_CHECK
        );

    log(
        "🆕 Последние посты:",
        latest.map(p => `#${p.id}`).join(", ")
    );

    return latest;
}

// ============================================================
// СКАЧИВАНИЕ КАРТИНКИ
// ============================================================

async function downloadImage(url) {
    log("📥 Скачиваем картинку...");

    const response =
        await axios.get(
            url,
            {
                responseType: "arraybuffer",
                timeout: IMAGE_TIMEOUT,
                maxContentLength:
                    15 * 1024 * 1024,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",

                    Referer:
                        "https://t.me/"
                }
            }
        );

    const buffer =
        Buffer.from(response.data);

    log(
        `✅ Картинка скачана: ${buffer.length} байт`
    );

    return buffer;
}

// ============================================================
// ОБРАБОТКА ИЗОБРАЖЕНИЯ
// ============================================================

async function prepareImage(buffer) {
    try {
        const metadata =
            await sharp(buffer)
                .metadata();

        log(
            `🖼 Исходное изображение: ${metadata.width}x${metadata.height}`
        );

        /*
            Увеличиваем изображение.

            OCR особенно плохо читает мелкие цифры,
            поэтому увеличиваем до 2200 px.
        */

        return await sharp(buffer)
            .rotate()
            .resize({
                width: 2200,
                withoutEnlargement: false
            })
            .grayscale()
            .normalize()
            .sharpen({
                sigma: 1.2
            })
            .png()
            .toBuffer();

    } catch (error) {
        log(
            `⚠️ Ошибка обработки изображения: ${error.message}`
        );

        return buffer;
    }
}

// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer) {
    log("🔍 Запускаем OCR...");

    const prepared =
        await prepareImage(buffer);

    const start =
        Date.now();

    const result =
        await Tesseract.recognize(
            prepared,
            "rus+eng",
            {
                logger: message => {
                    if (
                        message.status ===
                        "recognizing text"
                    ) {
                        const percent =
                            Math.round(
                                (message.progress || 0) *
                                100
                            );

                        if (
                            percent % 10 === 0
                        ) {
                            log(
                                `⏳ OCR: ${percent}%`
                            );
                        }
                    }
                }
            }
        );

    const text =
        result?.data?.text || "";

    log(
        `✅ OCR завершён за ${Math.round(
            (Date.now() - start) / 1000
        )} сек`
    );

    console.log("");
    console.log(
        "========== OCR TEXT =========="
    );
    console.log(text);
    console.log(
        "================================"
    );
    console.log("");

    return text;
}

// ============================================================
// ОБРАБОТКА ПОСТА
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
// ПОИСК СВЕЖИХ КУРСОВ
// ============================================================

async function fetchLatestRates() {
    log("");
    log(
        "=========================================="
    );
    log(
        "🔄 ПОИСК САМЫХ НОВЫХ КУРСОВ"
    );
    log(
        "=========================================="
    );

    const posts =
        await getLatestPosts();

    /*
        ВАЖНО:

        Всегда начинаем с самого нового поста.
    */

    for (const post of posts) {
        try {
            const result =
                await processPost(post);

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
                    `✅ Пост #${post.id}`
                );

                log(
                    `✅ Курсов ${result.count}/9`
                );

                return {
                    rates: result.rates,
                    postId: post.id,
                    text: result.text
                };
            }

            log(
                `⚠️ Пост #${post.id} не подходит`
            );

        } catch (error) {
            log(
                `❌ Ошибка поста #${post.id}: ${error.message}`
            );
        }
    }

    throw new Error(
        "Не найден подходящий пост с курсами"
    );
}

// ============================================================
// ОБНОВЛЕНИЕ
// ============================================================

async function updateRates(force = false) {
    if (updateInProgress) {
        log(
            "⏳ Обновление уже выполняется"
        );

        return {
            rates: cachedRates,
            post: cachedPost,
            source: "busy"
        };
    }

    const now =
        Date.now();

    // CACHE
    if (
        !force &&
        cachedRates &&
        now - lastFetch < CACHE_TTL
    ) {
        log(
            "📦 Возвращаем данные из CACHE"
        );

        return {
            rates: cachedRates,
            post: cachedPost,
            source: "cache"
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
            rates: cachedRates,
            post: cachedPost,
            source: "ocr"
        };

    } finally {
        updateInProgress = false;
    }
}

// ============================================================
// API: /api/rates
// ============================================================

app.get(
    "/api/rates",
    async (req, res) => {
        try {
            const result =
                await updateRates(false);

            res.json({
                success: true,
                rates: result.rates,
                post: result.post,
                source: result.source,
                updatedAt:
                    lastFetch
                        ? new Date(
                            lastFetch
                        ).toISOString()
                        : null
            });

        } catch (error) {
            log(
                `❌ /api/rates: ${error.message}`
            );

            // Старые рабочие данные
            if (cachedRates) {
                return res.json({
                    success: true,
                    rates: cachedRates,
                    post: cachedPost,
                    source: "stale-cache",
                    warning: error.message,
                    updatedAt:
                        new Date(
                            lastFetch
                        ).toISOString()
                });
            }

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

// ============================================================
// API: ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ
// ============================================================

app.get(
    "/api/rates/refresh",
    async (req, res) => {
        try {
            log("");
            log(
                "🔄 FORCE REFRESH"
            );

            const result =
                await updateRates(true);

            res.json({
                success: true,
                rates: result.rates,
                post: result.post,
                source: "fresh-ocr",
                updatedAt:
                    new Date(
                        lastFetch
                    ).toISOString()
            });

        } catch (error) {
            log(
                `❌ Refresh: ${error.message}`
            );

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

// ============================================================
// API: OCR DEBUG
// ============================================================

app.get(
    "/api/debug/ocr",
    (req, res) => {
        res.json({
            post: cachedPost,
            rates: cachedRates,
            ocr: cachedOcrText
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
            status: "ok",
            service: "LoyaltySwift OCR",
            channel: CHANNEL,
            cached: !!cachedRates,
            post: cachedPost,
            cacheAge:
                lastFetch
                    ? Date.now() - lastFetch
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
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>LoyaltySwift OCR</title>

<style>

body {
    margin: 0;
    padding: 30px;

    background: #07151b;
    color: white;

    font-family:
        Arial,
        sans-serif;
}

.container {
    max-width: 700px;
    margin: auto;
}

h1 {
    color: #00d9ff;
}

a {
    display: block;

    margin: 15px 0;
    padding: 18px;

    background: #102832;

    color: #00d9ff;

    text-decoration: none;

    border-radius: 10px;

    font-size: 18px;
}

a:hover {
    background: #163b48;
}

.info {
    margin-top: 30px;

    padding: 20px;

    background: #0c2028;

    border-radius: 10px;

    color: #b8d5dd;
}

</style>

</head>

<body>

<div class="container">

<h1>🚀 LoyaltySwift OCR</h1>

<p>
Сервер парсинга курсов работает.
</p>

<a href="/api/rates">
💰 Получить текущие курсы
</a>

<a href="/api/rates/refresh">
🔄 Найти самый новый пост
</a>

<a href="/api/debug/ocr">
🔍 Посмотреть последний OCR
</a>

<a href="/health">
❤️ Проверить сервер
</a>

<div class="info">

<b>Канал:</b> @LoyaltySwift<br><br>

<b>OCR:</b> Tesseract.js<br>

<b>Обработка изображения:</b> Sharp<br>

<b>Кэш:</b> 2 минуты

</div>

</div>

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
        log("");
        log(
            "=========================================="
        );
        log(
            "🚀 LOYALTY SWIFT OCR SERVER"
        );
        log(
            "=========================================="
        );

        log(
            `🌐 PORT: ${PORT}`
        );

        log(
            `📢 CHANNEL: @${CHANNEL}`
        );

        log(
            `📡 TELEGRAM: ${TELEGRAM_URL}`
        );

        log(
            "🧠 OCR: Tesseract.js rus+eng"
        );

        log(
            "🖼 IMAGE: Sharp preprocessing"
        );

        log(
            `💾 CACHE: ${CACHE_TTL / 1000} sec`
        );

        log(
            `🔎 POSTS TO CHECK: ${MAX_POSTS_TO_CHECK}`
        );

        log(
            "=========================================="
        );

        log(
            "✅ SERVER READY"
        );

        log(
            "=========================================="
        );
    }
);
