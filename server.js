'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL = 'LoyaltySwift';
const TELEGRAM_URL = `https://t.me/s/${CHANNEL}`;

// Проверяем Telegram каждые 60 секунд
const CHECK_INTERVAL = 60 * 1000;

// Не OCR-им десятки старых постов.
// Максимум 2 кандидата: новый и один предыдущий.
const MAX_POSTS_TO_TRY = 2;

app.use(cors());
app.use(express.json());


// ============================================================
// СОСТОЯНИЕ
// ============================================================

let currentRates = null;

let currentPostId = null;
let currentPostDate = null;
let currentImageUrl = null;

let lastSuccessfulUpdate = null;
let lastCheckTime = 0;

let updateInProgress = false;
let ocrWorker = null;


// ============================================================
// HTTP
// ============================================================

const http = axios.create({
    timeout: 20000,

    maxRedirects: 5,

    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/131.0 Safari/537.36',

        'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

        'Accept-Language':
            'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});


function log(...args) {
    console.log(
        `[${new Date().toISOString()}]`,
        ...args
    );
}


// ============================================================
// HTML HELPERS
// ============================================================

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}


function normalizeUrl(url) {
    if (!url) return null;

    let result = decodeHtml(url).trim();

    result = result.replace(/\\u0026/g, '&');

    if (result.startsWith('//')) {
        result = 'https:' + result;
    }

    if (result.startsWith('http://')) {
        result = 'https://' + result.slice(7);
    }

    return result;
}


function htmlToText(html) {
    return decodeHtml(
        String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim()
    );
}


// ============================================================
// TELEGRAM
// ============================================================

function extractImageFromBlock(block) {
    const urls = [];

    let match;

    // Telegram обычно хранит фото здесь
    const bgRegex =
        /background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

    while ((match = bgRegex.exec(block)) !== null) {
        const url = normalizeUrl(match[1]);

        if (url) {
            urls.push(url);
        }
    }

    // Дополнительный вариант
    const srcRegex =
        /<img\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi;

    while ((match = srcRegex.exec(block)) !== null) {
        const url = normalizeUrl(match[1]);

        if (url) {
            urls.push(url);
        }
    }

    return [...new Set(urls)][0] || null;
}


async function getTelegramPosts() {
    log('📡 Получаем свежие посты Telegram...');

    const response = await http.get(
        `${TELEGRAM_URL}?_=${Date.now()}`
    );

    const html = response.data;

    if (typeof html !== 'string') {
        throw new Error('Telegram вернул не HTML');
    }

    const markerRegex =
        /<div\b[^>]*data-post=["']LoyaltySwift\/(\d+)["'][^>]*>/gi;

    const markers = [];

    let match;

    while ((match = markerRegex.exec(html)) !== null) {
        markers.push({
            id: Number(match[1]),
            index: match.index
        });
    }

    if (!markers.length) {
        throw new Error(
            'Не удалось найти посты LoyaltySwift'
        );
    }

    const posts = [];

    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;

        const end =
            i + 1 < markers.length
                ? markers[i + 1].index
                : html.length;

        const block = html.slice(start, end);

        const text = htmlToText(block);

        const dateMatch = text.match(
            /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\b/
        );

        const imageUrl =
            extractImageFromBlock(block);

        posts.push({
            id: markers[i].id,
            date: dateMatch ? dateMatch[0] : null,
            imageUrl,
            text
        });
    }

    // Убираем дубли
    const unique = [];
    const seen = new Set();

    for (const post of posts) {
        if (seen.has(post.id)) continue;

        seen.add(post.id);
        unique.push(post);
    }

    // Самый новый пост имеет максимальный ID
    unique.sort((a, b) => b.id - a.id);

    log(
        `📊 Найдено постов: ${unique.length}`
    );

    for (const post of unique.slice(0, 5)) {
        log(
            `📰 #${post.id} | ${post.date || '-'} | ` +
            `${post.imageUrl ? '📷' : 'нет картинки'}`
        );
    }

    return unique;
}


// ============================================================
// OCR
// ============================================================

async function getOCRWorker() {
    if (ocrWorker) {
        return ocrWorker;
    }

    log('🔧 Запускаем Tesseract...');

    ocrWorker = await Tesseract.createWorker(
        'rus+eng',
        1,
        {
            logger: data => {
                if (
                    data.status === 'recognizing text' &&
                    typeof data.progress === 'number'
                ) {
                    const percent =
                        Math.round(data.progress * 100);

                    if (percent % 10 === 0) {
                        process.stdout.write(
                            `\r🔍 OCR: ${percent}%`
                        );
                    }
                }
            }
        }
    );

    await ocrWorker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1'
    });

    console.log('');

    log('✅ Tesseract готов');

    return ocrWorker;
}


// ============================================================
// СКАЧИВАНИЕ КАРТИНКИ
// ============================================================

async function downloadImage(url) {
    log('📥 Скачиваем картинку...');

    const response = await axios.get(
        url,
        {
            responseType: 'arraybuffer',
            timeout: 20000,
            maxContentLength: 20 * 1024 * 1024,
            maxBodyLength: 20 * 1024 * 1024,

            headers: {
                'User-Agent':
                    'Mozilla/5.0 Chrome/131 Safari/537.36',

                'Referer':
                    'https://t.me/'
            }
        }
    );

    const buffer =
        Buffer.from(response.data);

    if (!buffer.length) {
        throw new Error('Картинка пустая');
    }

    log(
        `✅ Картинка скачана: ${buffer.length} байт`
    );

    return buffer;
}


// ============================================================
// ПОДГОТОВКА КАРТИНКИ
// ============================================================

async function prepareImage(buffer, mode = 1) {

    let image =
        sharp(buffer)
            .rotate()
            .resize({
                width: 2200,
                withoutEnlargement: false,
                fit: 'inside'
            });

    if (mode === 1) {
        // Основной вариант
        return image
            .grayscale()
            .normalize()
            .sharpen({
                sigma: 1
            })
            .png()
            .toBuffer();
    }

    // Второй вариант для сложного OCR
    return image
        .grayscale()
        .linear(1.3, -20)
        .sharpen({
            sigma: 1.5
        })
        .png()
        .toBuffer();
}


// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer, mode = 1) {

    const prepared =
        await prepareImage(
            buffer,
            mode
        );

    const worker =
        await getOCRWorker();

    log(
        `🔍 OCR вариант ${mode}...`
    );

    const result =
        await worker.recognize(
            prepared
        );

    const text =
        result?.data?.text || '';

    console.log('\n========== OCR TEXT ==========');
    console.log(text);
    console.log('================================\n');

    return text;
}


// ============================================================
// НОРМАЛИЗАЦИЯ OCR
// ============================================================

function normalizeOCR(text) {

    return String(text || '')
        .replace(/\r/g, '\n')

        // Заменяем похожие символы
        .replace(/[–—−]/g, '-')
        .replace(/[：]/g, ':')
        .replace(/[，]/g, ',')

        // Частые ошибки OCR
        .replace(/\bU5D\b/gi, 'USD')
        .replace(/\bUSO\b/gi, 'USD')
        .replace(/\bU5D\b/gi, 'USD')

        .replace(/\bJPV\b/gi, 'JPY')
        .replace(/\bJpY\b/gi, 'JPY')
        .replace(/\bJY\b/gi, 'JPY')

        .replace(/\bKRVV\b/gi, 'KRW')
        .replace(/\bKRV\b/gi, 'KRW')

        .replace(/\bCNU\b/gi, 'CNY')
        .replace(/\bCNV\b/gi, 'CNY')

        .replace(/IDUBlD/gi, 'IDUBID')
        .replace(/IDUB1D/gi, 'IDUBID')

        // OCR иногда делает QR-C0DE
        .replace(/QR[- ]?C0DE/gi, 'QR-CODE')

        .replace(/[ \t]+/g, ' ');
}


// ============================================================
// ЧИСЛА
// ============================================================

function parseNumber(value) {
    if (!value) return null;

    const n = Number(
        String(value)
            .replace(/\s/g, '')
            .replace(',', '.')
    );

    return Number.isFinite(n)
        ? n
        : null;
}


function getNumber(text, regex) {
    const match = text.match(regex);

    if (!match) {
        return null;
    }

    return parseNumber(match[1]);
}


// ============================================================
// ПОИСК КУРСА В ТЕКСТЕ
// ============================================================

function extractRates(rawText) {

    const normalized =
        normalizeOCR(rawText);

    const lines =
        normalized
            .split('\n')
            .map(line =>
                line
                    .replace(/\s+/g, ' ')
                    .trim()
            )
            .filter(Boolean);


    // Берём не только одну строку,
    // потому что OCR может разделить:
    //
    // 1 USD =
    // 87.20
    //
    // на две строки.
    const contexts = [];

    for (let i = 0; i < lines.length; i++) {

        contexts.push({
            index: i,
            text: lines
                .slice(
                    Math.max(0, i - 2),
                    Math.min(lines.length, i + 3)
                )
                .join(' ')
        });
    }


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

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /1\s*USD\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
            );

        if (
            value === null ||
            value < 50 ||
            value > 150
        ) {
            continue;
        }

        if (
            /IDUBID/i.test(item.text)
        ) {
            result.USD_IDUBID = value;
        } else if (
            result.USD === null
        ) {
            result.USD = value;
        }
    }


    // ========================================================
    // JPY SWIFT
    // ========================================================

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /100\s*JPY\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
            );

        if (
            value === null ||
            value < 10 ||
            value > 100
        ) {
            continue;
        }

        if (
            /SWIFT/i.test(item.text)
        ) {
            result.JPY_SWIFT = value;
        }
    }


    // Если SWIFT не распознан как слово,
    // всё равно берём 100 JPY.
    if (result.JPY_SWIFT === null) {

        for (const item of contexts) {

            const value =
                getNumber(
                    item.text,
                    /100\s*JPY\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
                );

            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {
                result.JPY_SWIFT = value;
                break;
            }
        }
    }


    // ========================================================
    // AFA CASH
    // ========================================================

    for (const item of contexts) {

        if (
            !/AFA/i.test(item.text)
        ) {
            continue;
        }

        if (
            !/(налич|cash)/i.test(item.text)
        ) {
            continue;
        }

        const value =
            getNumber(
                item.text,
                /1\s*JPY\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
            );

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {
            result.JPY_AFA_CASH = value;
            break;
        }
    }


    // ========================================================
    // AFA QR
    // ========================================================

    for (const item of contexts) {

        if (
            !/AFA/i.test(item.text)
        ) {
            continue;
        }

        if (
            !/QR/i.test(item.text)
        ) {
            continue;
        }

        const value =
            getNumber(
                item.text,
                /1\s*JPY\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
            );

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {
            result.JPY_AFA_QR = value;
            break;
        }
    }


    // ========================================================
    // JPY FALLBACK
    // ========================================================

    /*
       Если OCR потерял слова "наличные" / "QR-code",
       ищем все значения:

       1 JPY = 55.80
       1 JPY = 55.30
    */

    const allOneJPY = [];

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /1\s*JPY\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
            );

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            if (!allOneJPY.includes(value)) {
                allOneJPY.push(value);
            }
        }
    }


    if (
        result.JPY_AFA_CASH === null &&
        allOneJPY.length >= 1
    ) {
        result.JPY_AFA_CASH =
            allOneJPY[0];
    }


    if (
        result.JPY_AFA_QR === null &&
        allOneJPY.length >= 2
    ) {
        result.JPY_AFA_QR =
            allOneJPY[1];
    }


    // ========================================================
    // KRW
    // ========================================================

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /1000\s*KRW\s*=?\s*(\d{2,3}[.,]\d{1,2})/i
            );

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

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /1\s*AED\s*=?\s*(\d{1,2}[.,]\d{1,2})/i
            );

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

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /1\s*CNY\s*=?\s*(\d{1,2}[.,]\d{1,2})/i
            );

        if (
            value !== null &&
            value >= 1 &&
            value <= 30
        ) {
            result.CNY = value;
            break;
        }
    }


    // CNY fallback через КИТАЙ
    if (result.CNY === null) {

        for (const item of contexts) {

            if (
                !/КИТАЙ|CHINA/i.test(item.text)
            ) {
                continue;
            }

            const numbers =
                item.text.match(
                    /\b\d{1,2}[.,]\d{1,2}\b/g
                );

            if (!numbers) continue;

            for (const n of numbers) {

                const value =
                    parseNumber(n);

                if (
                    value >= 1 &&
                    value <= 30
                ) {
                    result.CNY = value;
                    break;
                }
            }

            if (result.CNY !== null) {
                break;
            }
        }
    }


    // ========================================================
    // THB
    // ========================================================

    for (const item of contexts) {

        const value =
            getNumber(
                item.text,
                /1\s*THB\s*=?\s*(\d{1,2}[.,]\d{1,2})/i
            );

        if (
            value !== null &&
            value >= 0.1 &&
            value <= 10
        ) {
            result.THB = value;
            break;
        }
    }


    log(
        '💰 Результат OCR:',
        JSON.stringify(
            result,
            null,
            2
        )
    );


    return result;
}


// ============================================================
// ПРОВЕРКА РЕЗУЛЬТАТА
// ============================================================

function countRates(rates) {

    return Object.values(rates)
        .filter(
            value =>
                typeof value === 'number' &&
                Number.isFinite(value)
        )
        .length;
}


function isGoodResult(rates) {

    const count =
        countRates(rates);

    /*
       Не требуем все 9.
       Для принятия новой картинки
       достаточно 4 значений.

       Но желательно 6+.
    */

    return count >= 4;
}


// ============================================================
// ОБРАБОТКА ПОСТА
// ============================================================

async function processPost(post) {

    log(
        `\n📰 Обрабатываем новый пост #${post.id}`
    );

    if (!post.imageUrl) {
        log('⚠️ В посте нет картинки');
        return null;
    }

    try {

        const image =
            await downloadImage(
                post.imageUrl
            );


        // Первый OCR
        const text1 =
            await recognizeImage(
                image,
                1
            );


        const rates1 =
            extractRates(
                text1
            );


        const count1 =
            countRates(
                rates1
            );


        log(
            `📊 Первый OCR: ${count1}/9`
        );


        if (
            isGoodResult(rates1)
        ) {

            return {
                rates: rates1,
                text: text1,
                ocrPass: 1
            };
        }


        // ====================================================
        // Второй OCR ТОЛЬКО если первый плохой
        // ====================================================

        log(
            '🔁 Первый OCR слабый, запускаем второй вариант...'
        );


        const text2 =
            await recognizeImage(
                image,
                2
            );


        const rates2 =
            extractRates(
                text2
            );


        const count2 =
            countRates(
                rates2
            );


        log(
            `📊 Второй OCR: ${count2}/9`
        );


        if (
            count2 > count1 &&
            isGoodResult(rates2)
        ) {

            return {
                rates: rates2,
                text: text2,
                ocrPass: 2
            };
        }


        if (
            isGoodResult(rates1)
        ) {

            return {
                rates: rates1,
                text: text1,
                ocrPass: 1
            };
        }


        return null;

    } catch (error) {

        log(
            `❌ Ошибка поста #${post.id}:`,
            error.message
        );

        return null;
    }
}


// ============================================================
// ОБНОВЛЕНИЕ КУРСОВ
// ============================================================

async function updateRates() {

    if (updateInProgress) {

        log(
            '⏳ Обновление уже выполняется'
        );

        return;
    }


    updateInProgress = true;


    try {

        const posts =
            await getTelegramPosts();


        if (!posts.length) {
            throw new Error(
                'Telegram не вернул посты'
            );
        }


        /*
           Самый новый пост.
        */

        const newest =
            posts[0];


        log(
            `🆕 Самый новый пост: #${newest.id}`
        );


        /*
           Если это тот же пост,
           OCR заново не запускаем.
        */

        if (
            currentPostId !== null &&
            newest.id === currentPostId
        ) {

            log(
                `📦 Пост #${newest.id} уже обработан`
            );

            return;
        }


        /*
           Сначала пробуем ТОЛЬКО новый пост.
        */

        const result =
            await processPost(
                newest
            );


        if (result) {

            currentRates =
                result.rates;

            currentPostId =
                newest.id;

            currentPostDate =
                newest.date;

            currentImageUrl =
                newest.imageUrl;

            lastSuccessfulUpdate =
                new Date().toISOString();


            log(
                `\n🎉 НОВЫЕ КУРСЫ ПОЛУЧЕНЫ!`
            );

            log(
                `📰 Пост: #${currentPostId}`
            );

            log(
                `📅 Дата: ${currentPostDate}`
            );

            log(
                `🔍 OCR pass: ${result.ocrPass}`
            );

            log(
                JSON.stringify(
                    currentRates,
                    null,
                    2
                )
            );

            return;
        }


        /*
           Новый пост не распознался.

           Тогда один раз пробуем предыдущий пост,
           чтобы API не остался без курсов.
        */

        log(
            `⚠️ Новый пост #${newest.id} не распознан`
        );


        if (
            currentPostId === null &&
            posts[1]
        ) {

            log(
                `🔄 Пробуем предыдущий пост #${posts[1].id}`
            );


            const oldResult =
                await processPost(
                    posts[1]
                );


            if (oldResult) {

                currentRates =
                    oldResult.rates;

                currentPostId =
                    posts[1].id;

                currentPostDate =
                    posts[1].date;

                currentImageUrl =
                    posts[1].imageUrl;

                lastSuccessfulUpdate =
                    new Date().toISOString();


                log(
                    `✅ Используем пост #${currentPostId}`
                );
            }
        }

    } catch (error) {

        log(
            '❌ Ошибка обновления:',
            error.message
        );

    } finally {

        updateInProgress =
            false;
    }
}


// ============================================================
// API RATES
// ============================================================

app.get(
    '/api/rates',
    async (req, res) => {

        try {

            const now =
                Date.now();


            /*
               Если проверяли недавно,
               отдаём кеш.
            */

            if (
                currentRates &&
                now - lastCheckTime <
                    CHECK_INTERVAL
            ) {

                return res.json({
                    success: true,

                    rates:
                        currentRates,

                    source:
                        'cache',

                    post:
                        currentPostId,

                    date:
                        currentPostDate,

                    updatedAt:
                        lastSuccessfulUpdate
                });
            }


            lastCheckTime =
                now;


            await updateRates();


            /*
               Если получили новые курсы.
            */

            if (currentRates) {

                return res.json({
                    success: true,

                    rates:
                        currentRates,

                    source:
                        'ocr',

                    post:
                        currentPostId,

                    date:
                        currentPostDate,

                    updatedAt:
                        lastSuccessfulUpdate
                });
            }


            res.status(503).json({

                success: false,

                error:
                    'Курсы пока не распознаны'
            });

        } catch (error) {

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
    '/api/rates/refresh',
    async (req, res) => {

        lastCheckTime = 0;

        await updateRates();

        if (!currentRates) {

            return res.status(503).json({
                success: false,
                error:
                    'Не удалось получить курсы'
            });
        }

        res.json({

            success: true,

            rates:
                currentRates,

            source:
                'manual-refresh',

            post:
                currentPostId,

            date:
                currentPostDate,

            updatedAt:
                lastSuccessfulUpdate
        });
    }
);


// ============================================================
// DEBUG
// ============================================================

app.get(
    '/api/debug',
    async (req, res) => {

        try {

            const posts =
                await getTelegramPosts();


            res.json({

                currentPost:
                    currentPostId,

                currentDate:
                    currentPostDate,

                rates:
                    currentRates,

                updatedAt:
                    lastSuccessfulUpdate,

                newestPosts:
                    posts
                        .slice(0, 10)
                        .map(post => ({
                            id:
                                post.id,

                            date:
                                post.date,

                            hasImage:
                                Boolean(
                                    post.imageUrl
                                ),

                            imageUrl:
                                post.imageUrl
                        }))
            });

        } catch (error) {

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
    '/health',
    (req, res) => {

        res.json({

            status:
                'ok',

            currentPost:
                currentPostId,

            hasRates:
                Boolean(currentRates),

            ocr:
                Boolean(ocrWorker),

            updatedAt:
                lastSuccessfulUpdate
        });
    }
);


// ============================================================
// ROOT
// ============================================================

app.get(
    '/',
    (req, res) => {

        res.send(`
<!DOCTYPE html>

<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>LoyaltySwift Rates</title>

<style>

body {
    margin: 0;
    padding: 30px;
    background: #061116;
    color: white;
    font-family: Arial, sans-serif;
}

.container {
    max-width: 800px;
    margin: auto;
}

.card {
    background: #10252c;
    border-radius: 16px;
    padding: 25px;
    margin-bottom: 20px;
}

h1 {
    color: #00d9ff;
}

a {
    color: #00d9ff;
}

pre {
    white-space: pre-wrap;
    word-break: break-word;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>
🚀 LoyaltySwift Rates
</h1>

<p>
Сервер работает.
</p>

</div>

<div class="card">

<h2>
API
</h2>

<p>
<a href="/api/rates">
/api/rates
</a>
</p>

<p>
<a href="/api/rates/refresh">
/api/rates/refresh
</a>
</p>

<p>
<a href="/api/debug">
/api/debug
</a>
</p>

<p>
<a href="/health">
/health
</a>
</p>

</div>

<div class="card">

<h2>
Текущие курсы
</h2>

<pre id="rates">
Загрузка...
</pre>

</div>

</div>

<script>

fetch('/api/rates')
    .then(response => response.json())
    .then(data => {

        document.getElementById('rates')
            .textContent =
            JSON.stringify(
                data,
                null,
                2
            );

    })
    .catch(error => {

        document.getElementById('rates')
            .textContent =
            error.message;

    });

</script>

</body>

</html>
        `);
    }
);


// ============================================================
// ФОНОВАЯ ПРОВЕРКА
// ============================================================

async function backgroundCheck() {

    if (updateInProgress) {
        return;
    }

    log(
        '⏰ Проверяем новый пост...'
    );

    await updateRates();
}


// ============================================================
// START
// ============================================================

async function start() {

    log(
        '======================================'
    );

    log(
        '🚀 LoyaltySwift OCR v3'
    );

    log(
        `📡 ${TELEGRAM_URL}`
    );

    log(
        `🌐 PORT: ${PORT}`
    );

    log(
        '⏱ Проверка: 60 секунд'
    );

    log(
        '======================================'
    );


    app.listen(
        PORT,
        () => {

            log(
                `✅ Server listening on ${PORT}`
            );


            /*
               Первая проверка через 3 секунды,
               чтобы Render успел поднять HTTP.
            */

            setTimeout(
                backgroundCheck,
                3000
            );


            setInterval(
                backgroundCheck,
                CHECK_INTERVAL
            );
        }
    );
}


// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {

    log(
        '🛑 Завершение работы...'
    );

    if (ocrWorker) {

        try {
            await ocrWorker.terminate();
        } catch (e) {
            log(
                'Ошибка остановки OCR:',
                e.message
            );
        }
    }

    process.exit(0);
}


process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);


// ============================================================
// RUN
// ============================================================

start();
