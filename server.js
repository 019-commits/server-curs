const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL = 'LoyaltySwift';

const TELEGRAM_URL =
    `https://t.me/s/${CHANNEL}`;

// ============================================================
// НАСТРОЙКИ
// ============================================================

const CACHE_TTL = 2 * 60 * 1000;

// Сколько последних постов проверять
const MAX_POSTS_TO_CHECK = 12;

// После OCR должно быть найдено минимум столько курсов
const MIN_RATES_REQUIRED = 6;

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

let isUpdating = false;

// ============================================================
// ЛОГ
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

function parseNumber(value) {
    if (value === null || value === undefined) {
        return null;
    }

    let text = String(value)
        .trim()
        .replace(/\s/g, '')
        .replace(',', '.');

    const number = Number(text);

    if (!Number.isFinite(number)) {
        return null;
    }

    return number;
}

// ============================================================
// НОРМАЛИЗАЦИЯ КУРСА
// ============================================================

function normalizeRate(value) {
    const number = parseNumber(value);

    if (number === null) {
        return null;
    }

    /*
        OCR иногда видит:

        1 JPY = 5580

        хотя на картинке:

        1 JPY = 55.80

        Поэтому исправляем такие числа.
    */

    if (
        Number.isInteger(number) &&
        number >= 1000 &&
        number <= 10000
    ) {
        return number / 100;
    }

    return number;
}

// ============================================================
// НОРМАЛИЗАЦИЯ OCR
// ============================================================

function normalizeOCR(text) {

    return String(text || '')
        .replace(/\r/g, '\n')

        // тире
        .replace(/[–—−]/g, '-')

        // запятая
        .replace(/[，]/g, ',')

        // ----------------------------------------------------
        // USD
        // ----------------------------------------------------

        .replace(/\bU5D\b/gi, 'USD')
        .replace(/\bUSO\b/gi, 'USD')
        .replace(/\bUsD\b/g, 'USD')
        .replace(/\bU5D\b/gi, 'USD')

        // ----------------------------------------------------
        // JPY
        // ----------------------------------------------------

        .replace(/\bJPV\b/gi, 'JPY')
        .replace(/\bJpY\b/gi, 'JPY')
        .replace(/\bJY\b/gi, 'JPY')

        // OCR может написать 13PY вместо JPY
        .replace(/\b13PY\b/gi, 'JPY')
        .replace(/\bI3PY\b/gi, 'JPY')
        .replace(/\bJ3Y\b/gi, 'JPY')
        .replace(/\bIJPY\b/gi, 'JPY')

        // ----------------------------------------------------
        // KRW
        // ----------------------------------------------------

        .replace(/\bKRVV\b/gi, 'KRW')
        .replace(/\bKRV\b/gi, 'KRW')
        .replace(/\bKRW\b/gi, 'KRW')

        // ----------------------------------------------------
        // CNY
        // ----------------------------------------------------

        .replace(/\bCNU\b/gi, 'CNY')
        .replace(/\bCNV\b/gi, 'CNY')
        .replace(/\bCNУ\b/gi, 'CNY')
        .replace(/\beNy\b/g, 'CNY')
        .replace(/\bENY\b/g, 'CNY')
        .replace(/\bCnY\b/g, 'CNY')

        // ----------------------------------------------------
        // THB
        // ----------------------------------------------------

        .replace(/\bTH8\b/gi, 'THB')
        .replace(/\bTHВ\b/gi, 'THB')
        .replace(/\bTНB\b/gi, 'THB')
        .replace(/\bтнв\b/gi, 'THB')
        .replace(/\bтн8\b/gi, 'THB')

        // ----------------------------------------------------
        // AED
        // ----------------------------------------------------

        .replace(/\bAЕD\b/gi, 'AED')
        .replace(/\bАЕD\b/gi, 'AED')
        .replace(/\bАЕр\b/gi, 'AED')
        .replace(/\bАЕР\b/gi, 'AED')
        .replace(/\bAЕр\b/gi, 'AED')
        .replace(/\bAEP\b/gi, 'AED')

        // ----------------------------------------------------
        // IDUBID
        // ----------------------------------------------------

        .replace(/IDUBlD/gi, 'IDUBID')
        .replace(/IDUB1D/gi, 'IDUBID')
        .replace(/IDUBID/gi, 'IDUBID')

        // ----------------------------------------------------
        // пробелы
        // ----------------------------------------------------

        .replace(/[ \t]+/g, ' ');
}

// ============================================================
// ИЗВЛЕЧЕНИЕ КУРСОВ
// ============================================================

function extractRates(rawText) {

    const normalized = normalizeOCR(rawText);

    const lines = normalized
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    const result = {
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
            /\b1\s*USD\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = parseNumber(match[1]);

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

    // Первый USD = SWIFT

    if (usdValues.length >= 1) {
        result.USD = usdValues[0].value;
    }

    // IDUBID на той же строке

    for (const item of usdValues) {

        if (/IDUBID/i.test(item.line)) {
            result.USD_IDUBID = item.value;
        }
    }

    // IDUBID может быть на соседней строке

    if (result.USD_IDUBID === null) {

        for (let i = 0; i < lines.length; i++) {

            if (!/IDUBID/i.test(lines[i])) {
                continue;
            }

            for (
                let j = i;
                j <= Math.min(i + 3, lines.length - 1);
                j++
            ) {

                const match = lines[j].match(
                    /\b1\s*USD\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
                );

                if (!match) {
                    continue;
                }

                const value = parseNumber(match[1]);

                if (
                    value !== null &&
                    value >= 50 &&
                    value <= 150
                ) {
                    result.USD_IDUBID = value;
                    break;
                }
            }

            if (result.USD_IDUBID !== null) {
                break;
            }
        }
    }

    // Если IDUBID потерялся в OCR,
    // второй USD считаем IDUBID

    if (
        result.USD_IDUBID === null &&
        usdValues.length >= 2
    ) {
        result.USD_IDUBID = usdValues[1].value;
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

        const value = parseNumber(match[1]);

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {
            result.KRW = value;
            break;
        }
    }

    // ========================================================
    // AED
    // ========================================================

    for (const line of lines) {

        const match = line.match(
            /\b1\s*AED\s*=?\s*(\d{1,2}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = parseNumber(match[1]);

        if (
            value !== null &&
            value >= 5 &&
            value <= 50
        ) {
            result.AED = value;
            break;
        }
    }

    // ========================================================
    // CNY
    // ========================================================

    for (const line of lines) {

        const match = line.match(
            /\b1\s*CNY\s*=?\s*(\d{1,4}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        let value = parseNumber(match[1]);

        /*
            OCR:

            1 CNY = 1315

            На картинке:

            1 CNY = 13.15
        */

        if (
            value !== null &&
            value >= 100 &&
            value <= 10000
        ) {
            value = value / 100;
        }

        if (
            value !== null &&
            value >= 1 &&
            value <= 30
        ) {
            result.CNY = value;
            break;
        }
    }

    // ========================================================
    // THB
    // ========================================================

    for (const line of lines) {

        const match = line.match(
            /\b1\s*THB\s*=?\s*(\d{1,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = parseNumber(match[1]);

        if (
            value !== null &&
            value >= 0.1 &&
            value <= 10
        ) {
            result.THB = value;
            break;
        }
    }

    // ========================================================
    // JPY SWIFT
    // ========================================================

    for (const line of lines) {

        const match = line.match(
            /\b100\s*JPY\s*=?\s*(\d{2,3}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = parseNumber(match[1]);

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {
            result.JPY_SWIFT = value;
            break;
        }
    }

    // ========================================================
    // AFA
    // ========================================================

    const afaRates = [];

    for (let i = 0; i < lines.length; i++) {

        const line = lines[i];

        const match = line.match(
            /\b1\s*JPY\s*=?\s*(\d{2,4}(?:[.,]\d{1,2})?)/i
        );

        if (!match) {
            continue;
        }

        const value = normalizeRate(match[1]);

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {
            afaRates.push({
                index: i,
                value,
                line
            });
        }
    }

    // ========================================================
    // Ищем AFA CASH
    // ========================================================

    for (let i = 0; i < lines.length; i++) {

        if (
            !/AFA/i.test(lines[i]) &&
            !/налич/i.test(lines[i]) &&
            !/cash/i.test(lines[i])
        ) {
            continue;
        }

        for (
            let j = i;
            j <= Math.min(i + 3, lines.length - 1);
            j++
        ) {

            const match = lines[j].match(
                /\b1\s*JPY\s*=?\s*(\d{2,4}(?:[.,]\d{1,2})?)/i
            );

            if (!match) {
                continue;
            }

            const value = normalizeRate(match[1]);

            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {
                result.JPY_AFA_CASH = value;
                break;
            }
        }
    }

    // ========================================================
    // Ищем AFA QR
    // ========================================================

    for (let i = 0; i < lines.length; i++) {

        if (
            !/AFA/i.test(lines[i]) &&
            !/QR/i.test(lines[i])
        ) {
            continue;
        }

        for (
            let j = i;
            j <= Math.min(i + 3, lines.length - 1);
            j++
        ) {

            const match = lines[j].match(
                /\b1\s*JPY\s*=?\s*(\d{2,4}(?:[.,]\d{1,2})?)/i
            );

            if (!match) {
                continue;
            }

            const value = normalizeRate(match[1]);

            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {
                result.JPY_AFA_QR = value;
                break;
            }
        }
    }

    // ========================================================
    // FALLBACK AFA
    // ========================================================

    /*
        Если OCR не увидел слова CASH / QR,
        но увидел две строки:

        1 JPY = 55.80
        1 JPY = 55.30

        используем их как CASH / QR.
    */

    if (
        result.JPY_AFA_CASH === null &&
        afaRates.length >= 1
    ) {
        result.JPY_AFA_CASH =
            afaRates[0].value;
    }

    if (
        result.JPY_AFA_QR === null &&
        afaRates.length >= 2
    ) {
        result.JPY_AFA_QR =
            afaRates[1].value;
    }

    // ========================================================
    // ФИНАЛЬНЫЙ ЛОГ
    // ========================================================

    const found = Object.values(result)
        .filter(value => value !== null)
        .length;

    log('💰 Результат OCR:', JSON.stringify(result, null, 2));

    log(
        `📊 Найдено курсов: ${found}/9`
    );

    return result;
}

// ============================================================
// ОЦЕНКА РЕЗУЛЬТАТА
// ============================================================

function countRates(rates) {

    if (!rates) {
        return 0;
    }

    return Object.values(rates)
        .filter(value =>
            value !== null &&
            Number.isFinite(value)
        )
        .length;
}

// ============================================================
// ПРОВЕРКА КУРСОВ
// ============================================================

function validateRates(rates) {

    if (!rates) {
        return false;
    }

    const count = countRates(rates);

    /*
        Для твоей картинки ожидается 9 значений.

        Но если какой-то элемент OCR не увидит,
        пост всё равно может быть принят при 6.
    */

    return count >= MIN_RATES_REQUIRED;
}

// ============================================================
// ПОЛУЧЕНИЕ HTML TELEGRAM
// ============================================================

async function getTelegramPage() {

    log('🌐 Загружаем Telegram...');

    const response = await axios.get(
        TELEGRAM_URL,
        {
            timeout: 20000,
            responseType: 'text',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',

                'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',

                'Accept-Language':
                    'ru-RU,ru;q=0.9,en;q=0.8'
            }
        }
    );

    return response.data;
}

// ============================================================
// ПОИСК ПОСТОВ
// ============================================================

function extractPosts(html) {

    const posts = [];

    /*
        Telegram public channel:

        data-post="LoyaltySwift/1340"
    */

    const postRegex =
        /data-post=["']LoyaltySwift\/(\d+)["'][\s\S]*?<\/div>\s*<\/div>/gi;

    /*
        Более надёжно ищем все data-post отдельно.
    */

    const ids = [];

    const idRegex =
        /data-post=["']LoyaltySwift\/(\d+)["']/gi;

    let idMatch;

    while (
        (idMatch = idRegex.exec(html)) !== null
    ) {

        const id = Number(idMatch[1]);

        if (!ids.includes(id)) {
            ids.push(id);
        }
    }

    /*
        Для каждого ID ищем область рядом с ним.
    */

    for (const id of ids) {

        const marker =
            `LoyaltySwift/${id}`;

        const position =
            html.indexOf(marker);

        if (position === -1) {
            continue;
        }

        /*
            Берём большой кусок HTML после поста.
            Этого достаточно, чтобы найти фото.
        */

        const block =
            html.substring(
                position,
                position + 15000
            );

        // ----------------------------------------------------
        // IMAGE
        // ----------------------------------------------------

        let imageUrl = null;

        /*
            Telegram часто отдаёт:

            background-image:url('...')
        */

        let imageMatch =
            block.match(
                /background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i
            );

        if (imageMatch) {
            imageUrl = imageMatch[1];
        }

        /*
            Иногда встречается просто src.
        */

        if (!imageUrl) {

            imageMatch =
                block.match(
                    /<img[^>]+src=["']([^"']+)["']/i
                );

            if (imageMatch) {
                imageUrl = imageMatch[1];
            }
        }

        /*
            Иногда URL экранирован.
        */

        if (imageUrl) {

            imageUrl =
                imageUrl
                    .replace(/&amp;/g, '&')
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/');
        }

        // ----------------------------------------------------
        // ТЕКСТ ПОСТА
        // ----------------------------------------------------

        const cleanText =
            block
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/\s+/g, ' ')
                .trim();

        const hasRateKeywords =
            /КУРС|USD|JPY|KRW|AED|CNY|THB|SWIFT|AFA|IDUBID/i
                .test(cleanText);

        posts.push({
            id,
            imageUrl,
            text: cleanText,
            hasRateKeywords
        });
    }

    /*
        Убираем дубликаты.
    */

    const unique = [];

    const used = new Set();

    for (const post of posts) {

        if (used.has(post.id)) {
            continue;
        }

        used.add(post.id);

        if (post.imageUrl) {
            unique.push(post);
        }
    }

    /*
        Самый большой ID = самый новый пост.
    */

    unique.sort(
        (a, b) => b.id - a.id
    );

    return unique;
}

// ============================================================
// ПОЛУЧИТЬ ПОСЛЕДНИЕ ПОСТЫ
// ============================================================

async function getLatestPosts() {

    const html =
        await getTelegramPage();

    const posts =
        extractPosts(html);

    log(
        `📊 Найдено постов с изображениями: ${posts.length}`
    );

    if (posts.length === 0) {

        throw new Error(
            'Telegram не вернул посты с изображениями'
        );
    }

    return posts.slice(
        0,
        MAX_POSTS_TO_CHECK
    );
}

// ============================================================
// СКАЧИВАНИЕ КАРТИНКИ
// ============================================================

async function downloadImage(url) {

    log('📥 Скачиваем картинку...');

    const response =
        await axios.get(
            url,
            {
                responseType: 'arraybuffer',
                timeout: 30000,
                maxContentLength:
                    15 * 1024 * 1024,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',

                    'Referer':
                        'https://t.me/'
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
// ПОДГОТОВКА КАРТИНКИ
// ============================================================

async function prepareImage(buffer) {

    /*
        OCR работает намного лучше,
        если заранее:

        - увеличивать изображение
        - переводить в grayscale
        - усиливать контраст
        - немного sharpen
    */

    try {

        const image =
            sharp(buffer);

        const metadata =
            await image.metadata();

        log(
            `🖼 Размер картинки: ${metadata.width}x${metadata.height}`
        );

        let pipeline =
            image
                .rotate()
                .resize({
                    width: 1800,
                    withoutEnlargement: false
                })
                .grayscale()
                .normalize()
                .sharpen();

        return await pipeline.png().toBuffer();

    } catch (error) {

        log(
            `⚠️ Не удалось обработать картинку: ${error.message}`
        );

        return buffer;
    }
}

// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer) {

    log('🔍 Запускаем OCR...');

    const prepared =
        await prepareImage(buffer);

    const start =
        Date.now();

    const result =
        await Tesseract.recognize(
            prepared,
            'rus+eng',
            {
                logger: message => {

                    if (
                        message.status ===
                        'recognizing text'
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
        result &&
        result.data &&
        result.data.text
            ? result.data.text
            : '';

    log(
        `✅ OCR завершён за ${Math.round(
            (Date.now() - start) / 1000
        )} сек`
    );

    log('');
    log('========== OCR TEXT ==========');
    console.log(text);
    log('================================');

    return text;
}

// ============================================================
// ОБРАБОТКА ОДНОГО ПОСТА
// ============================================================

async function processPost(post) {

    log('');
    log(
        `📌 Проверяем пост #${post.id}`
    );

    log(
        `🔗 ${post.imageUrl}`
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
// ПОИСК НОВЫХ КУРСОВ
// ============================================================

async function fetchLatestRates() {

    log('');
    log('==========================================');
    log('🔄 ПОИСК НОВОГО ПОСТА С КУРСАМИ');
    log('==========================================');

    const posts =
        await getLatestPosts();

    /*
        Проверяем новые посты от самого нового
        к старым.

        Поэтому если сегодня появился:

        #1350

        он будет проверен раньше:

        #1349
        #1348
        #1347
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

                log('');
                log(
                    `🎉 НОВЫЕ КУРСЫ ПОЛУЧЕНЫ!`
                );

                log(
                    `✅ Пост: #${post.id}`
                );

                log(
                    `✅ Курсов: ${result.count}/9`
                );

                return {
                    rates: result.rates,
                    postId: post.id,
                    text: result.text
                };
            }

            log(
                `⚠️ Пост #${post.id} не прошёл проверку`
            );

        } catch (error) {

            log(
                `❌ Ошибка поста #${post.id}: ${error.message}`
            );
        }
    }

    throw new Error(
        'Не удалось найти пост с корректными курсами'
    );
}

// ============================================================
// ОСНОВНОЕ ОБНОВЛЕНИЕ
// ============================================================

async function updateRates(force = false) {

    /*
        Если уже идёт обновление,
        не запускаем второе одновременно.
    */

    if (isUpdating) {

        log(
            '⏳ Обновление уже выполняется'
        );

        return {
            rates: cachedRates,
            post: cachedPost,
            busy: true
        };
    }

    const now =
        Date.now();

    /*
        CACHE
    */

    if (
        !force &&
        cachedRates &&
        now - lastFetch < CACHE_TTL
    ) {

        log(
            '📦 Возвращаем данные из CACHE'
        );

        return {
            rates: cachedRates,
            post: cachedPost,
            source: 'cache'
        };
    }

    isUpdating = true;

    try {

        const result =
            await fetchLatestRates();

        /*
            Сохраняем новые курсы
        */

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
            source: 'ocr'
        };

    } finally {

        isUpdating = false;
    }
}

// ============================================================
// API /rates
// ============================================================

app.get('/api/rates', async (req, res) => {

    try {

        const result =
            await updateRates(false);

        res.json({
            success: true,

            rates: result.rates,

            post: result.post,

            source:
                result.source || 'ocr',

            updatedAt:
                new Date(
                    lastFetch
                ).toISOString()
        });

    } catch (error) {

        log(
            `❌ /api/rates: ${error.message}`
        );

        /*
            Если есть старые рабочие курсы,
            лучше вернуть их, чем отдавать ошибку.
        */

        if (cachedRates) {

            return res.json({
                success: true,
                rates: cachedRates,
                post: cachedPost,
                source: 'stale-cache',
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
});

// ============================================================
// ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ
// ============================================================

app.get('/api/rates/refresh', async (req, res) => {

    try {

        log('');
        log(
            '🔄 ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ'
        );

        const result =
            await updateRates(true);

        res.json({
            success: true,
            rates: result.rates,
            post: result.post,
            source: 'fresh-ocr',
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
});

// ============================================================
// ПОКАЗ OCR
// ============================================================

app.get('/api/debug/ocr', (req, res) => {

    res.json({
        post: cachedPost,
        rates: cachedRates,
        ocr: cachedOcrText
    });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (req, res) => {

    res.json({
        status: 'ok',
        service: 'LoyaltySwift OCR',
        channel: CHANNEL,
        cached: !!cachedRates,
        post: cachedPost
    });
});

// ============================================================
// ГЛАВНАЯ
// ============================================================

app.get('/', (req, res) => {

    res.send(`
<!DOCTYPE html>

<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>LoyaltySwift Rates</title>

<style>

body {
    background: #07151b;
    color: white;
    font-family: Arial, sans-serif;
    padding: 30px;
}

h1 {
    color: #00d9ff;
}

a {
    display: block;
    margin: 15px 0;
    padding: 15px;
    background: #102832;
    color: #00d9ff;
    text-decoration: none;
    border-radius: 8px;
}

a:hover {
    background: #163a47;
}

</style>

</head>

<body>

<h1>🚀 LoyaltySwift OCR</h1>

<p>Парсер курсов работает.</p>

<a href="/api/rates">
    💰 Получить курсы
</a>

<a href="/api/rates/refresh">
    🔄 Принудительно обновить
</a>

<a href="/api/debug/ocr">
    🔍 Посмотреть OCR
</a>

<a href="/health">
    ❤️ Health Check
</a>

</body>

</html>
`);
});

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        log('');
        log('==========================================');
        log('🚀 LOYALTY SWIFT OCR SERVER');
        log('==========================================');

        log(
            `🌐 Порт: ${PORT}`
        );

        log(
            `📢 Канал: @${CHANNEL}`
        );

        log(
            `📡 Telegram: ${TELEGRAM_URL}`
        );

        log(
            `🧠 OCR: Tesseract.js rus+eng`
        );

        log(
            `🖼 Image preprocessing: Sharp`
        );

        log(
            `💾 Cache: ${CACHE_TTL / 1000} секунд`
        );

        log(
            `🔎 Проверяем последних постов: ${MAX_POSTS_TO_CHECK}`
        );

        log('');
        log(
            '✅ Сервер готов'
        );
        log('==========================================');
    }
);
