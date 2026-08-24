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

const CHECK_INTERVAL = 30 * 1000;
const MAX_POSTS_TO_CHECK = 15;

app.use(cors());
app.use(express.json());


// ============================================================
// STATE
// ============================================================

let rates = null;

let currentPostId = null;
let currentPostDate = null;
let currentImageUrl = null;

let lastSuccessfulUpdate = null;
let lastCheck = 0;

let updatePromise = null;
let worker = null;


// ============================================================
// HTTP
// ============================================================

const http = axios.create({
    timeout: 30000,

    maxRedirects: 5,

    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 Chrome/131.0 Safari/537.36',

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
// OCR
// ============================================================

async function initOCR() {

    if (worker) {
        return worker;
    }

    log('🔧 Загружаем Tesseract...');

    worker = await Tesseract.createWorker(
        'rus+eng',
        1,
        {
            logger: data => {

                if (
                    data.status === 'recognizing text' &&
                    typeof data.progress === 'number'
                ) {

                    const p =
                        Math.round(data.progress * 100);

                    if (p % 10 === 0) {
                        process.stdout.write(
                            `\r🔍 OCR: ${p}%`
                        );
                    }
                }
            }
        }
    );

    await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1'
    });

    console.log('');

    log('✅ Tesseract готов');

    return worker;
}


// ============================================================
// HTML
// ============================================================

function decodeHtml(text) {

    return String(text || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
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


function normalizeUrl(url) {

    if (!url) {
        return null;
    }

    let result =
        decodeHtml(url)
            .trim();

    result =
        result.replace(
            /\\u0026/g,
            '&'
        );

    if (result.startsWith('//')) {
        result = 'https:' + result;
    }

    if (result.startsWith('http://')) {
        result =
            'https://' +
            result.substring(7);
    }

    return result;
}


// ============================================================
// TELEGRAM POSTS
// ============================================================

function extractImages(block) {

    const urls = [];

    let match;


    // background-image
    const backgroundRegex =
        /background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;

    while (
        (match = backgroundRegex.exec(block))
    ) {

        const url =
            normalizeUrl(match[1]);

        if (url) {
            urls.push(url);
        }
    }


    // img src
    const imgRegex =
        /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

    while (
        (match = imgRegex.exec(block))
    ) {

        const url =
            normalizeUrl(match[1]);

        if (url) {
            urls.push(url);
        }
    }


    // data-src
    const dataRegex =
        /(?:data-src|data-image)\s*=\s*["']([^"']+)["']/gi;

    while (
        (match = dataRegex.exec(block))
    ) {

        const url =
            normalizeUrl(match[1]);

        if (url) {
            urls.push(url);
        }
    }


    return [
        ...new Set(urls)
    ];
}


async function getTelegramPosts() {

    log('📡 Получаем посты Telegram...');

    const response =
        await http.get(
            `${TELEGRAM_URL}?_=${Date.now()}`
        );

    const html =
        response.data;

    if (
        typeof html !== 'string'
    ) {

        throw new Error(
            'Telegram вернул неправильный ответ'
        );
    }


    const posts = [];

    const regex =
        /<div\b[^>]*data-post=["']LoyaltySwift\/(\d+)["'][^>]*>/gi;

    const starts = [];

    let match;


    while (
        (match = regex.exec(html))
    ) {

        starts.push({
            id: Number(match[1]),
            index: match.index
        });
    }


    if (!starts.length) {

        throw new Error(
            'Посты LoyaltySwift не найдены'
        );
    }


    for (
        let i = 0;
        i < starts.length;
        i++
    ) {

        const current =
            starts[i];

        const next =
            starts[i + 1];

        const end =
            next
                ? next.index
                : html.length;

        const block =
            html.substring(
                current.index,
                end
            );

        const text =
            htmlToText(block);

        const images =
            extractImages(block);


        const dateMatch =
            text.match(
                /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\b/
            );


        posts.push({

            id:
                current.id,

            date:
                dateMatch
                    ? dateMatch[0]
                    : null,

            text,

            imageUrl:
                images[0] || null
        });
    }


    // Новый пост имеет больший ID
    posts.sort(
        (a, b) =>
            b.id - a.id
    );


    const unique = [];
    const seen = new Set();


    for (
        const post of posts
    ) {

        if (
            seen.has(post.id)
        ) {
            continue;
        }

        seen.add(post.id);

        unique.push(post);
    }


    log(
        `📊 Найдено постов: ${unique.length}`
    );


    for (
        const post of unique.slice(0, 10)
    ) {

        log(
            `📰 #${post.id} | ${post.date || '-'} | ` +
            `${post.imageUrl ? 'IMAGE' : 'NO IMAGE'}`
        );
    }


    return unique;
}


// ============================================================
// IMAGE
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
                    20 * 1024 * 1024,
                maxBodyLength:
                    20 * 1024 * 1024,

                headers: {
                    'User-Agent':
                        'Mozilla/5.0 Chrome/131 Safari/537.36',

                    'Referer':
                        'https://t.me/'
                }
            }
        );


    const buffer =
        Buffer.from(
            response.data
        );


    if (
        !buffer.length
    ) {

        throw new Error(
            'Картинка пустая'
        );
    }


    log(
        `✅ Картинка: ${buffer.length} bytes`
    );


    return buffer;
}


// ============================================================
// IMAGE PREPROCESS
// ============================================================

async function prepareImage(buffer) {

    return sharp(buffer)
        .rotate()
        .resize({
            width: 2200,
            fit: 'inside',
            withoutEnlargement: false
        })
        .grayscale()
        .normalize()
        .sharpen({
            sigma: 1
        })
        .png()
        .toBuffer();
}


// ============================================================
// OCR
// ============================================================

async function recognize(buffer) {

    const ocr =
        await initOCR();

    log('🔍 OCR...');

    const result =
        await ocr.recognize(buffer);

    const text =
        result?.data?.text || '';

    console.log('\n========== OCR ==========');
    console.log(text);
    console.log('=========================\n');

    return text;
}


// ============================================================
// OCR NORMALIZATION
// ============================================================

function normalizeOCR(text) {

    return String(text || '')

        .replace(/\r/g, '\n')

        .replace(/[–—−]/g, '-')

        .replace(/[：]/g, ':')

        .replace(/[，]/g, ',')

        .replace(/[≈≡]/g, '=')

        // JPY
        .replace(/\bJpY\b/gi, 'JPY')
        .replace(/\bJPV\b/gi, 'JPY')
        .replace(/\bJY\b/gi, 'JPY')

        // USD
        .replace(/\bU5D\b/gi, 'USD')
        .replace(/\bUSO\b/gi, 'USD')

        // KRW
        .replace(/\bKRVV\b/gi, 'KRW')
        .replace(/\bKRV\b/gi, 'KRW')

        // CNY
        .replace(/\bCNV\b/gi, 'CNY')

        // IDUBID
        .replace(/IDUBlD/gi, 'IDUBID')

        .replace(/[ \t]+/g, ' ');
}


// ============================================================
// NUMBER HELPERS
// ============================================================

function number(value) {

    if (!value) {
        return null;
    }

    const result =
        Number(
            String(value)
                .replace(/\s/g, '')
                .replace(',', '.')
        );

    if (
        !Number.isFinite(result)
    ) {
        return null;
    }

    return result;
}


function findNumber(text, regex) {

    const match =
        text.match(regex);

    if (!match) {
        return null;
    }

    return number(match[1]);
}


// ============================================================
// RATE EXTRACTION
// ============================================================

function extractRates(rawText) {

    const text =
        normalizeOCR(rawText);


    const lines =
        text
            .split('\n')
            .map(
                line =>
                    line
                        .replace(/\s+/g, ' ')
                        .trim()
            )
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
    // USD SWIFT
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findNumber(
                line,
                /1\s*USD\s*=\s*(\d+[.,]\d+)/i
            );

        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            if (
                !/IDUBID/i.test(line)
            ) {

                result.USD =
                    value;

                break;
            }
        }
    }


    // ========================================================
    // USD IDUBID
    // ========================================================

    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const context =
            lines
                .slice(
                    Math.max(0, i - 2),
                    Math.min(lines.length, i + 3)
                )
                .join(' ');


        if (
            !/IDUBID/i.test(context)
        ) {
            continue;
        }


        const value =
            findNumber(
                context,
                /1\s*USD\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            result.USD_IDUBID =
                value;

            break;
        }
    }


    // ========================================================
    // JPY SWIFT
    // ========================================================

    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const line =
            lines[i];


        const value =
            findNumber(
                line,
                /100\s*JPY\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            const context =
                lines
                    .slice(
                        Math.max(0, i - 2),
                        Math.min(lines.length, i + 3)
                    )
                    .join(' ');


            if (
                /SWIFT/i.test(context)
            ) {

                result.JPY_SWIFT =
                    value;

                break;
            }
        }
    }


    // Если слово SWIFT OCR потерял
    if (
        result.JPY_SWIFT === null
    ) {

        for (
            const line of lines
        ) {

            const value =
                findNumber(
                    line,
                    /100\s*JPY\s*=\s*(\d+[.,]\d+)/i
                );


            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {

                result.JPY_SWIFT =
                    value;

                break;
            }
        }
    }


    // ========================================================
    // AFA CASH
    // ========================================================

    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const context =
            lines
                .slice(
                    Math.max(0, i - 3),
                    Math.min(lines.length, i + 4)
                )
                .join(' ');


        const isAFA =
            /AFA/i.test(context);


        const isCash =
            /наличн|cash/i.test(context);


        if (
            !isAFA ||
            !isCash
        ) {

            continue;
        }


        const value =
            findNumber(
                context,
                /1\s*JPY\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            result.JPY_AFA_CASH =
                value;

            break;
        }
    }


    // ========================================================
    // AFA QR
    // ========================================================

    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const context =
            lines
                .slice(
                    Math.max(0, i - 3),
                    Math.min(lines.length, i + 4)
                )
                .join(' ');


        const isAFA =
            /AFA/i.test(context);


        const isQR =
            /QR|QR-code|QR code/i.test(context);


        if (
            !isAFA ||
            !isQR
        ) {

            continue;
        }


        const value =
            findNumber(
                context,
                /1\s*JPY\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            result.JPY_AFA_QR =
                value;

            break;
        }
    }


    // ========================================================
    // FALLBACK AFA
    // ========================================================

    /*
       Если OCR смешал блоки,
       берём все значения 1 JPY.

       В твоей картинке это обычно:

       55.80
       55.30
    */

    const jpyValues = [];


    for (
        const line of lines
    ) {

        const value =
            findNumber(
                line,
                /1\s*JPY\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            if (
                !jpyValues.includes(value)
            ) {

                jpyValues.push(value);
            }
        }
    }


    if (
        result.JPY_AFA_CASH === null &&
        jpyValues.length >= 2
    ) {

        result.JPY_AFA_CASH =
            jpyValues[0];
    }


    if (
        result.JPY_AFA_QR === null &&
        jpyValues.length >= 2
    ) {

        result.JPY_AFA_QR =
            jpyValues[1];
    }


    // ========================================================
    // KRW
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findNumber(
                line,
                /1000\s*KRW\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            result.KRW =
                value;

            break;
        }
    }


    // ========================================================
    // AED
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findNumber(
                line,
                /1\s*AED\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 5 &&
            value <= 50
        ) {

            result.AED =
                value;

            break;
        }
    }


    // ========================================================
    // CNY
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findNumber(
                line,
                /1\s*(?:CNY|CNU)\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 1 &&
            value <= 30
        ) {

            result.CNY =
                value;

            break;
        }
    }


    // Если CNY не распознался,
    // ищем около слова КИТАЙ
    if (
        result.CNY === null
    ) {

        for (
            let i = 0;
            i < lines.length;
            i++
        ) {

            const context =
                lines
                    .slice(
                        Math.max(0, i - 2),
                        Math.min(lines.length, i + 3)
                    )
                    .join(' ');


            if (
                !/КИТАЙ|CHINA/i.test(context)
            ) {
                continue;
            }


            const value =
                findNumber(
                    context,
                    /(?:1\s*)?(?:CNY|CNU)\s*=\s*(\d+[.,]\d+)/i
                );


            if (
                value !== null &&
                value >= 1 &&
                value <= 30
            ) {

                result.CNY =
                    value;

                break;
            }
        }
    }


    // ========================================================
    // THB
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findNumber(
                line,
                /1\s*THB\s*=\s*(\d+[.,]\d+)/i
            );


        if (
            value !== null &&
            value >= 0.1 &&
            value <= 10
        ) {

            result.THB =
                value;

            break;
        }
    }


    log(
        '💰 Результат:',
        JSON.stringify(
            result,
            null,
            2
        )
    );


    return result;
}


// ============================================================
// VALIDATION
// ============================================================

function validateRates(data) {

    const checks = [

        [
            'USD',
            data.USD,
            50,
            150
        ],

        [
            'USD_IDUBID',
            data.USD_IDUBID,
            50,
            150
        ],

        [
            'JPY_SWIFT',
            data.JPY_SWIFT,
            10,
            100
        ],

        [
            'JPY_AFA_CASH',
            data.JPY_AFA_CASH,
            10,
            100
        ],

        [
            'JPY_AFA_QR',
            data.JPY_AFA_QR,
            10,
            100
        ],

        [
            'KRW',
            data.KRW,
            10,
            100
        ],

        [
            'AED',
            data.AED,
            5,
            50
        ],

        [
            'CNY',
            data.CNY,
            1,
            30
        ],

        [
            'THB',
            data.THB,
            0.1,
            10
        ]
    ];


    let valid = 0;


    for (
        const [
            name,
            value,
            min,
            max
        ] of checks
    ) {

        if (
            typeof value === 'number' &&
            value >= min &&
            value <= max
        ) {

            valid++;

        } else {

            log(
                `⚠️ ${name}:`,
                value
            );
        }
    }


    /*
       На картинке 9 значений.

       Требуем хотя бы 6,
       чтобы случайный OCR
       не заменил рабочие курсы.
    */

    return valid >= 6;
}


// ============================================================
// PROCESS POST
// ============================================================

async function processPost(post) {

    if (
        !post.imageUrl
    ) {

        return null;
    }


    log(
        `\n📰 Обрабатываем пост #${post.id}`
    );


    try {

        const original =
            await downloadImage(
                post.imageUrl
            );


        const prepared =
            await prepareImage(
                original
            );


        const text =
            await recognize(
                prepared
            );


        const extracted =
            extractRates(
                text
            );


        if (
            !validateRates(
                extracted
            )
        ) {

            log(
                `❌ Пост #${post.id} не прошёл валидацию`
            );

            return null;
        }


        return {

            rates:
                extracted,

            text
        };

    } catch (error) {

        log(
            `❌ Ошибка поста #${post.id}:`,
            error.message
        );

        return null;
    }
}


// ============================================================
// UPDATE RATES
// ============================================================

async function updateRates(force = false) {

    if (
        updatePromise
    ) {

        return updatePromise;
    }


    updatePromise =
        (async () => {

            try {

                const posts =
                    await getTelegramPosts();


                const candidates =
                    posts
                        .filter(
                            post =>
                                post.imageUrl
                        )
                        .slice(
                            0,
                            MAX_POSTS_TO_CHECK
                        );


                if (
                    !candidates.length
                ) {

                    throw new Error(
                        'Нет постов с картинками'
                    );
                }


                for (
                    const post of candidates
                ) {

                    /*
                       Уже используем этот пост.
                    */

                    if (
                        !force &&
                        currentPostId !== null &&
                        post.id === currentPostId
                    ) {

                        return {
                            rates,
                            postId:
                                currentPostId,
                            date:
                                currentPostDate,
                            imageUrl:
                                currentImageUrl,
                            source:
                                'cache'
                        };
                    }


                    /*
                       Не позволяем откатиться
                       на старый пост.
                    */

                    if (
                        !force &&
                        currentPostId !== null &&
                        post.id < currentPostId
                    ) {

                        continue;
                    }


                    const result =
                        await processPost(
                            post
                        );


                    if (
                        !result
                    ) {

                        continue;
                    }


                    rates =
                        result.rates;

                    currentPostId =
                        post.id;

                    currentPostDate =
                        post.date;

                    currentImageUrl =
                        post.imageUrl;

                    lastSuccessfulUpdate =
                        new Date().toISOString();


                    log(
                        `🎉 НОВЫЕ КУРСЫ ИЗ ПОСТА #${post.id}`
                    );


                    return {

                        rates,

                        postId:
                            currentPostId,

                        date:
                            currentPostDate,

                        imageUrl:
                            currentImageUrl,

                        source:
                            'ocr'
                    };
                }


                if (
                    rates
                ) {

                    return {

                        rates,

                        postId:
                            currentPostId,

                        date:
                            currentPostDate,

                        imageUrl:
                            currentImageUrl,

                        source:
                            'stale-cache'
                    };
                }


                throw new Error(
                    'Не найден подходящий пост с курсами'
                );

            } finally {

                updatePromise =
                    null;
            }
        })();


    return updatePromise;
}


// ============================================================
// /api/rates
// ============================================================

app.get(
    '/api/rates',
    async (req, res) => {

        try {

            const now =
                Date.now();


            if (
                rates &&
                lastCheck &&
                now - lastCheck <
                    CHECK_INTERVAL
            ) {

                return res.json({

                    success:
                        true,

                    rates,

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


            lastCheck =
                now;


            const result =
                await updateRates(
                    false
                );


            res.json({

                success:
                    true,

                rates:
                    result.rates,

                source:
                    result.source,

                post:
                    result.postId,

                date:
                    result.date,

                updatedAt:
                    lastSuccessfulUpdate
            });

        } catch (error) {

            log(
                '❌ API:',
                error.message
            );


            /*
               Если новые курсы временно
               не получили — отдаём последние.
            */

            if (
                rates
            ) {

                return res.json({

                    success:
                        true,

                    rates,

                    source:
                        'stale-cache',

                    post:
                        currentPostId,

                    date:
                        currentPostDate,

                    updatedAt:
                        lastSuccessfulUpdate,

                    warning:
                        error.message
                });
            }


            res.status(500)
                .json({

                    success:
                        false,

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

        try {

            lastCheck = 0;

            const result =
                await updateRates(
                    true
                );


            res.json({

                success:
                    true,

                rates:
                    result.rates,

                source:
                    result.source,

                post:
                    result.postId,

                date:
                    result.date,

                updatedAt:
                    lastSuccessfulUpdate
            });

        } catch (error) {

            res.status(500)
                .json({

                    success:
                        false,

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

                rates,

                updatedAt:
                    lastSuccessfulUpdate,

                posts:
                    posts
                        .slice(0, 20)
                        .map(
                            post => ({
                                id:
                                    post.id,

                                date:
                                    post.date,

                                image:
                                    Boolean(
                                        post.imageUrl
                                    ),

                                imageUrl:
                                    post.imageUrl
                            })
                        )
            });

        } catch (error) {

            res.status(500)
                .json({

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

            post:
                currentPostId,

            hasRates:
                Boolean(rates),

            ocrReady:
                Boolean(worker),

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
      content="width=device-width,initial-scale=1">

<title>LoyaltySwift Rates</title>

<style>

body {
    background:#061116;
    color:#fff;
    font-family:Arial,sans-serif;
    padding:30px;
}

.container {
    max-width:800px;
    margin:auto;
}

.card {
    background:#10252c;
    border-radius:16px;
    padding:25px;
    margin-bottom:20px;
}

h1 {
    color:#00d9ff;
}

a {
    color:#00d9ff;
}

pre {
    white-space:pre-wrap;
    word-break:break-word;
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
OCR сервер работает.
</p>

</div>

<div class="card">

<h2>
API
</h2>

<p>
<a href="/api/rates">
Получить курсы
</a>
</p>

<p>
<a href="/api/rates/refresh">
Принудительно обновить
</a>
</p>

<p>
<a href="/api/debug">
Debug
</a>
</p>

<p>
<a href="/health">
Health
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
    .then(r => r.json())
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
// BACKGROUND
// ============================================================

async function backgroundCheck() {

    try {

        log(
            '⏰ Проверяем новые посты...'
        );

        await updateRates(
            false
        );

    } catch (error) {

        log(
            '⚠️ Background:',
            error.message
        );
    }
}


// ============================================================
// START
// ============================================================

async function start() {

    log(
        '======================================'
    );

    log(
        '🚀 LoyaltySwift Rates v2'
    );

    log(
        `📡 ${TELEGRAM_URL}`
    );

    log(
        `🌐 PORT=${PORT}`
    );

    log(
        `⏱ CHECK=${CHECK_INTERVAL / 1000}s`
    );

    log(
        '======================================'
    );


    try {

        await initOCR();

    } catch (error) {

        log(
            '⚠️ OCR initialization:',
            error.message
        );
    }


    app.listen(
        PORT,
        () => {

            log(
                `🚀 Server started on ${PORT}`
            );


            setTimeout(
                backgroundCheck,
                5000
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
        '🛑 Shutdown...'
    );


    if (worker) {

        try {

            await worker.terminate();

        } catch (error) {

            log(
                error.message
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
