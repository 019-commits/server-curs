```javascript
'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const CHANNEL = 'LoyaltySwift';
const TELEGRAM_URL = `https://t.me/s/${CHANNEL}`;

const STATE_FILE = path.join(
    __dirname,
    'rates-state.json'
);

// Проверяем Telegram каждые 30 секунд
const CHECK_INTERVAL = 30 * 1000;

// Сколько последних постов проверять
const MAX_POSTS_TO_CHECK = 10;

// Размер картинки
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;


// ============================================================
// APP
// ============================================================

app.use(cors());
app.use(express.json());


// ============================================================
// STATE
// ============================================================

const defaultState = {
    rates: null,

    postId: null,
    postUrl: null,

    publishedAt: null,

    recognizedText: null,

    updatedAt: null,

    source: null
};

let state = loadState();

let updatePromise = null;

let lastCheckTime = 0;

let lastTelegramPosts = [];

let worker = null;


// ============================================================
// LOAD STATE
// ============================================================

function loadState() {

    try {

        if (!fs.existsSync(STATE_FILE)) {
            return { ...defaultState };
        }

        const raw =
            fs.readFileSync(
                STATE_FILE,
                'utf8'
            );

        const parsed =
            JSON.parse(raw);

        console.log(
            `📦 Загружено состояние. Последний пост: #${parsed.postId || 'нет'}`
        );

        return {
            ...defaultState,
            ...parsed
        };

    } catch (error) {

        console.error(
            '⚠️ Не удалось загрузить rates-state.json:',
            error.message
        );

        return { ...defaultState };
    }
}


// ============================================================
// SAVE STATE
// ============================================================

function saveState() {

    try {

        const tempFile =
            `${STATE_FILE}.tmp`;

        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                state,
                null,
                2
            ),
            'utf8'
        );

        fs.renameSync(
            tempFile,
            STATE_FILE
        );

    } catch (error) {

        console.error(
            '⚠️ Не удалось сохранить состояние:',
            error.message
        );
    }
}


// ============================================================
// HTTP CLIENT
// ============================================================

const http = axios.create({

    timeout: 25000,

    maxRedirects: 5,

    headers: {

        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/128.0 Safari/537.36',

        'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

        'Accept-Language':
            'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',

        'Cache-Control':
            'no-cache',

        'Pragma':
            'no-cache'
    }
});


// ============================================================
// TESSERACT WORKER
// ============================================================

async function initOCR() {

    if (worker) {
        return worker;
    }

    console.log(
        '🔧 Загружаем Tesseract...'
    );

    worker =
        await Tesseract.createWorker(
            ['rus', 'eng'],
            1,
            {
                logger: message => {

                    if (
                        message.status ===
                        'recognizing text' &&
                        typeof message.progress ===
                        'number'
                    ) {

                        const percent =
                            Math.round(
                                message.progress * 100
                            );

                        if (
                            percent % 10 === 0
                        ) {

                            console.log(
                                `🔍 OCR: ${percent}%`
                            );
                        }
                    }
                }
            }
        );


    await worker.setParameters({

        tessedit_pageseg_mode:
            Tesseract.PSM.SINGLE_BLOCK,

        preserve_interword_spaces:
            '1'
    });


    console.log(
        '✅ Tesseract готов'
    );


    return worker;
}


// ============================================================
// TELEGRAM PAGE
// ============================================================

async function getTelegramHTML() {

    console.log(
        '📡 Загружаем Telegram...'
    );


    const response =
        await http.get(
            `${TELEGRAM_URL}?_=${Date.now()}`
        );


    if (
        typeof response.data !==
        'string'
    ) {

        throw new Error(
            'Telegram вернул не HTML'
        );
    }


    console.log(
        `✅ Telegram HTML: ${response.data.length} bytes`
    );


    return response.data;
}


// ============================================================
// HTML DECODE
// ============================================================

function decodeHtml(value) {

    if (!value) {
        return '';
    }


    return value

        .replace(/&amp;/gi, '&')

        .replace(/&quot;/gi, '"')

        .replace(/&#39;/gi, "'")

        .replace(/&lt;/gi, '<')

        .replace(/&gt;/gi, '>');
}


// ============================================================
// HTML -> TEXT
// ============================================================

function htmlToText(html) {

    return decodeHtml(

        html

            .replace(
                /<script[\s\S]*?<\/script>/gi,
                ' '
            )

            .replace(
                /<style[\s\S]*?<\/style>/gi,
                ' '
            )

            .replace(
                /<br\s*\/?>/gi,
                '\n'
            )

            .replace(
                /<\/div>/gi,
                '\n'
            )

            .replace(
                /<\/p>/gi,
                '\n'
            )

            .replace(
                /<[^>]+>/g,
                ' '
            )

            .replace(
                /\s+/g,
                ' '
            )

            .trim()
    );
}


// ============================================================
// URL NORMALIZATION
// ============================================================

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


    if (
        result.startsWith('//')
    ) {

        result =
            'https:' + result;
    }


    if (
        result.startsWith('http://')
    ) {

        result =
            'https://' +
            result.substring(7);
    }


    return result;
}


// ============================================================
// EXTRACT IMAGE URLS
// ============================================================

function extractImageUrls(block) {

    const urls = [];


    // background-image:url(...)
    const backgroundRegex =
        /background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;


    let match;


    while (
        (match =
            backgroundRegex.exec(block))
        !== null
    ) {

        const url =
            normalizeUrl(
                match[1]
            );


        if (url) {
            urls.push(url);
        }
    }


    // <img src="">
    const imgRegex =
        /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;


    while (
        (match =
            imgRegex.exec(block))
        !== null
    ) {

        const url =
            normalizeUrl(
                match[1]
            );


        if (url) {
            urls.push(url);
        }
    }


    // data-src
    const dataSrcRegex =
        /(?:data-src|data-image)\s*=\s*["']([^"']+)["']/gi;


    while (
        (match =
            dataSrcRegex.exec(block))
        !== null
    ) {

        const url =
            normalizeUrl(
                match[1]
            );


        if (url) {
            urls.push(url);
        }
    }


    return [
        ...new Set(urls)
    ];
}


// ============================================================
// PARSE TELEGRAM POSTS
// ============================================================

function parseTelegramPosts(html) {

    const starts = [];


    /*
        Telegram:

        data-post="LoyaltySwift/12345"
    */

    const regex =
        /<div\b[^>]*\bdata-post=["']LoyaltySwift\/(\d+)["'][^>]*>/gi;


    let match;


    while (
        (match = regex.exec(html))
        !== null
    ) {

        starts.push({

            index:
                match.index,

            end:
                regex.lastIndex,

            id:
                Number(match[1])
        });
    }


    if (!starts.length) {

        throw new Error(
            'Не найдены Telegram data-post'
        );
    }


    const posts = [];


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


        const images =
            extractImageUrls(
                block
            );


        const text =
            htmlToText(
                block
            );


        const dateMatch =
            text.match(
                /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\b/
            );


        const date =
            dateMatch
                ? dateMatch[0]
                : null;


        const hasRateWords =
            /КУРС|КУРСЫ|USD|JPY|KRW|AED|THB|CNY|IDUBID|AFA/i
                .test(text);


        posts.push({

            id:
                current.id,

            date,

            text,

            images,

            imageUrl:
                images[0] || null,

            hasRateWords
        });
    }


    /*
        Самый большой ID = самый новый пост.
    */

    posts.sort(
        (a, b) =>
            b.id - a.id
    );


    /*
        Удаляем дубли.
    */

    const unique = [];

    const seen =
        new Set();


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


    return unique;
}


// ============================================================
// GET POSTS
// ============================================================

async function getLatestPosts() {

    const html =
        await getTelegramHTML();


    const posts =
        parseTelegramPosts(
            html
        );


    lastTelegramPosts =
        posts.slice(
            0,
            20
        );


    console.log(
        `📊 Найдено постов: ${posts.length}`
    );


    for (
        const post of posts.slice(
            0,
            10
        )
    ) {

        console.log(

            `#${post.id}` +

            ` | date=${post.date || '-'}` +

            ` | image=${post.imageUrl ? 'YES' : 'NO'}` +

            ` | rates=${post.hasRateWords ? 'YES' : 'NO'}`
        );
    }


    return posts;
}


// ============================================================
// DOWNLOAD IMAGE
// ============================================================

async function downloadImage(url) {

    console.log(
        '📥 Скачиваем картинку...'
    );


    const response =
        await axios.get(
            url,
            {

                responseType:
                    'arraybuffer',

                timeout:
                    30000,

                maxContentLength:
                    MAX_IMAGE_SIZE,

                maxBodyLength:
                    MAX_IMAGE_SIZE,

                headers: {

                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                        'AppleWebKit/537.36 Chrome/128.0 Safari/537.36',

                    'Referer':
                        'https://t.me/'
                }
            }
        );


    const buffer =
        Buffer.from(
            response.data
        );


    if (!buffer.length) {

        throw new Error(
            'Пустое изображение'
        );
    }


    console.log(
        `✅ Картинка: ${buffer.length} bytes`
    );


    return buffer;
}


// ============================================================
// IMAGE PREPROCESSING
// ============================================================

async function preprocessImage(buffer) {

    console.log(
        '🎨 Улучшаем изображение перед OCR...'
    );


    /*
        Исходная картинка примерно 950x1280.

        Увеличиваем до 1900 px по ширине,
        переводим в grayscale,
        normalize + sharpen.

        Это помогает Tesseract
        распознавать цифры.
    */

    const result =
        await sharp(buffer)

            .resize({

                width:
                    1900,

                withoutEnlargement:
                    false
            })

            .grayscale()

            .normalize()

            .sharpen({

                sigma:
                    1
            })

            .png()

            .toBuffer();


    console.log(
        `✅ Preprocessed image: ${result.length} bytes`
    );


    return result;
}


// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer) {

    const ocr =
        await initOCR();


    console.log(
        '🔍 Запускаем OCR...'
    );


    const result =
        await ocr.recognize(
            buffer
        );


    const text =
        result?.data?.text || '';


    console.log(
        '\n========== OCR =========='
    );

    console.log(
        text
    );

    console.log(
        '==========================\n'
    );


    return text;
}


// ============================================================
// NORMALIZE OCR
// ============================================================

function normalizeOCRText(text) {

    return String(text || '')

        .replace(/\r/g, '\n')

        .replace(
            /[–—−]/g,
            '-'
        )

        .replace(
            /[：]/g,
            ':'
        )

        .replace(
            /[，]/g,
            ','
        )

        .replace(
            /[≈≡]/g,
            '='
        )

        // JPY
        .replace(
            /\bJpY\b/gi,
            'JPY'
        )

        .replace(
            /\bJY\b/gi,
            'JPY'
        )

        .replace(
            /\bJPV\b/gi,
            'JPY'
        )

        // USD
        .replace(
            /\bU5D\b/gi,
            'USD'
        )

        .replace(
            /\bUSO\b/gi,
            'USD'
        )

        // KRW
        .replace(
            /\bKRVV\b/gi,
            'KRW'
        )

        .replace(
            /\bKRV\b/gi,
            'KRW'
        )

        // AED
        .replace(
            /\bAE0\b/gi,
            'AED'
        )

        // THB
        .replace(
            /\bTH8\b/gi,
            'THB'
        )

        // CNY
        .replace(
            /\bCNV\b/gi,
            'CNY'
        )

        // IDUBID
        .replace(
            /IDUBlD/gi,
            'IDUBID'
        )

        // лишние пробелы
        .replace(
            /[ \t]+/g,
            ' '
        )

        .trim();
}


// ============================================================
// PARSE NUMBER
// ============================================================

function parseNumber(value) {

    if (!value) {
        return null;
    }


    const result =
        Number(
            String(value)
                .replace(
                    /\s/g,
                    ''
                )
                .replace(
                    ',',
                    '.'
                )
        );


    if (
        !Number.isFinite(result)
    ) {

        return null;
    }


    return result;
}


// ============================================================
// EXTRACT RATES
// ============================================================

function extractRatesFromText(
    originalText
) {

    const text =
        normalizeOCRText(
            originalText
        );


    console.log(
        '\n========== NORMALIZED OCR =========='
    );

    console.log(
        text
    );

    console.log(
        '====================================\n'
    );


    const lines =
        text
            .split(/\n+/)
            .map(
                line =>
                    line.trim()
            )
            .filter(Boolean);


    const cleanLines =
        lines.map(
            line =>
                line
                    .replace(
                        /\s+/g,
                        ' '
                    )
                    .trim()
        );


    const rates = {};


    // ========================================================
    // helper
    // ========================================================

    function getNumberFromLines(
        patterns
    ) {

        for (
            const line of cleanLines
        ) {

            for (
                const pattern of patterns
            ) {

                const match =
                    line.match(
                        pattern
                    );


                if (!match) {
                    continue;
                }


                const value =
                    parseNumber(
                        match[1]
                    );


                if (
                    value !== null &&
                    value > 0
                ) {

                    return value;
                }
            }
        }


        return null;
    }


    // ========================================================
    // USD SWIFT
    // ========================================================

    const usd =
        getNumberFromLines([

            /1\s*USD\s*=\s*(\d+[.,]\d{1,4})/i,

            /USD\s*=\s*(\d+[.,]\d{1,4})/i
        ]);


    if (
        usd !== null
    ) {

        rates.USD =
            usd;

        console.log(
            `✅ USD = ${usd}`
        );
    }


    // ========================================================
    // JPY SWIFT
    // ========================================================

    const jpy100 =
        getNumberFromLines([

            /100\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i,

            /100\s*JY\s*=\s*(\d+[.,]\d{1,4})/i
        ]);


    if (
        jpy100 !== null
    ) {

        rates.JPY =
            Number(
                (
                    jpy100 / 100
                ).toFixed(6)
            );


        rates.JPY_SWIFT =
            rates.JPY;


        console.log(
            `✅ JPY = ${rates.JPY}`
        );
    }


    // ========================================================
    // AFA
    // ========================================================

    /*
        Ищем:

        AFA TRADING
        наличные
        1 JPY = 55.80

        или если OCR всё склеил:

        AFA TRADING наличные 1 JPY = 55.80
    */

    function findContextRate(
        contextPattern,
        ratePattern
    ) {

        for (
            let i = 0;
            i < cleanLines.length;
            i++
        ) {

            const context =
                cleanLines
                    .slice(
                        Math.max(
                            0,
                            i - 2
                        ),
                        Math.min(
                            cleanLines.length,
                            i + 3
                        )
                    )
                    .join(' ');


            if (
                !contextPattern.test(
                    context
                )
            ) {

                continue;
            }


            const match =
                context.match(
                    ratePattern
                );


            if (!match) {
                continue;
            }


            const value =
                parseNumber(
                    match[1]
                );


            if (
                value !== null &&
                value > 0
            ) {

                return value;
            }
        }


        return null;
    }


    // AFA CASH
    const afaCash =
        findContextRate(

            /AFA\s*TRADING/i,

            /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
        );


    /*
        Важно: если рядом есть QR,
        context может совпасть.

        Поэтому сначала ищем именно "наличные".
    */

    let afaCashExact =
        null;


    for (
        let i = 0;
        i < cleanLines.length;
        i++
    ) {

        const context =
            cleanLines
                .slice(
                    Math.max(
                        0,
                        i - 3
                    ),
                    Math.min(
                        cleanLines.length,
                        i + 4
                    )
                )
                .join(' ');


        if (
            !/AFA\s*TRADING/i.test(
                context
            )
        ) {
            continue;
        }


        if (
            !/наличн|cash/i.test(
                context
            )
        ) {
            continue;
        }


        const match =
            context.match(
                /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (match) {

            afaCashExact =
                parseNumber(
                    match[1]
                );

            break;
        }
    }


    if (
        afaCashExact !== null
    ) {

        rates.JPY_AFA =
            afaCashExact;

        console.log(
            `✅ JPY_AFA = ${afaCashExact}`
        );

    } else if (
        afaCash !== null
    ) {

        /*
            Не используем этот fallback сразу,
            потому что есть риск взять QR.
        */

        console.log(
            `ℹ️ Найден AFA без явного "наличные": ${afaCash}`
        );
    }


    // ========================================================
    // AFA QR
    // ========================================================

    let afaQR =
        null;


    for (
        let i = 0;
        i < cleanLines.length;
        i++
    ) {

        const context =
            cleanLines
                .slice(
                    Math.max(
                        0,
                        i - 3
                    ),
                    Math.min(
                        cleanLines.length,
                        i + 4
                    )
                )
                .join(' ');


        if (
            !/AFA\s*TRADING/i.test(
                context
            )
        ) {
            continue;
        }


        if (
            !/QR[\s-]*code|QR[\s-]*код/i.test(
                context
            )
        ) {
            continue;
        }


        const match =
            context.match(
                /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (match) {

            afaQR =
                parseNumber(
                    match[1]
                );

            break;
        }
    }


    if (
        afaQR !== null
    ) {

        rates.JPY_QR =
            afaQR;

        console.log(
            `✅ JPY_QR = ${afaQR}`
        );
    }


    // ========================================================
    // AFA FALLBACK
    // ========================================================

    /*
        Если OCR потерял слова "наличные"/"QR-code",
        собираем все 1 JPY = ...
    */

    if (
        rates.JPY_AFA === undefined ||
        rates.JPY_QR === undefined
    ) {

        const values = [];


        for (
            const line of cleanLines
        ) {

            const match =
                line.match(
                    /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
                );


            if (!match) {
                continue;
            }


            const value =
                parseNumber(
                    match[1]
                );


            if (
                value !== null &&
                !values.includes(value)
            ) {

                values.push(value);
            }
        }


        /*
            Для твоего шаблона:

            55.80 = наличные
            55.30 = QR
        */

        if (
            rates.JPY_AFA === undefined &&
            values.length >= 1
        ) {

            /*
                Если есть SWIFT 0.553,
                он сюда не попадёт,
                потому что здесь ищется "1 JPY".
            */

            rates.JPY_AFA =
                values[0];

            console.log(
                `⚠️ JPY_AFA fallback = ${values[0]}`
            );
        }


        if (
            rates.JPY_QR === undefined &&
            values.length >= 2
        ) {

            rates.JPY_QR =
                values[1];

            console.log(
                `⚠️ JPY_QR fallback = ${values[1]}`
            );
        }
    }


    // ========================================================
    // KRW
    // ========================================================

    const krw =
        getNumberFromLines([

            /1000\s*KRW\s*=\s*(\d+[.,]\d{1,4})/i,

            /1000\s*KRVV\s*=\s*(\d+[.,]\d{1,4})/i
        ]);


    if (
        krw !== null
    ) {

        rates.KRW =
            Number(
                (
                    krw / 1000
                ).toFixed(6)
            );


        console.log(
            `✅ KRW = ${rates.KRW}`
        );
    }


    // ========================================================
    // AED
    // ========================================================

    const aed =
        getNumberFromLines([

            /1\s*AED\s*=\s*(\d+[.,]\d{1,4})/i,

            /AED\s*=\s*(\d+[.,]\d{1,4})/i
        ]);


    if (
        aed !== null
    ) {

        rates.AED =
            aed;

        console.log(
            `✅ AED = ${aed}`
        );
    }


    // ========================================================
    // THB
    // ========================================================

    const thb =
        getNumberFromLines([

            /1\s*THB\s*=\s*(\d+[.,]\d{1,4})/i,

            /THB\s*=\s*(\d+[.,]\d{1,4})/i
        ]);


    if (
        thb !== null
    ) {

        rates.THB =
            thb;

        console.log(
            `✅ THB = ${thb}`
        );
    }


    // ========================================================
    // CNY
    // ========================================================

    const cny =
        getNumberFromLines([

            /1\s*CNY\s*=\s*(\d+[.,]\d{1,4})/i,

            /CNY\s*=\s*(\d+[.,]\d{1,4})/i
        ]);


    if (
        cny !== null
    ) {

        rates.CNY =
            cny;

        console.log(
            `✅ CNY = ${cny}`
        );
    }


    // ========================================================
    // IDUBID
    // ========================================================

    let idubid = null;


    for (
        let i = 0;
        i < cleanLines.length;
        i++
    ) {

        const context =
            cleanLines
                .slice(
                    Math.max(
                        0,
                        i - 2
                    ),
                    Math.min(
                        cleanLines.length,
                        i + 3
                    )
                )
                .join(' ');


        if (
            !/IDUBID/i.test(
                context
            )
        ) {
            continue;
        }


        const match =
            context.match(
                /1\s*USD\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (match) {

            idubid =
                parseNumber(
                    match[1]
                );

            break;
        }
    }


    if (
        idubid !== null
    ) {

        rates.USD_IDUBID =
            idubid;

        console.log(
            `✅ USD_IDUBID = ${idubid}`
        );

    } else {

        /*
            ВАЖНО:
            искусственный fallback оставляем
            только если реального IDUBID нет.
        */

        if (
            rates.USD !== undefined
        ) {

            rates.USD_IDUBID =
                Number(
                    (
                        rates.USD + 1.5
                    ).toFixed(4)
                );

            console.log(
                `⚠️ USD_IDUBID fallback = ${rates.USD_IDUBID}`
            );
        }
    }


    // ========================================================
    // RESULT
    // ========================================================

    console.log(
        '\n========== FINAL RATES =========='
    );

    console.log(
        rates
    );

    console.log(
        '=================================\n'
    );


    return rates;
}


// ============================================================
// VALIDATION
// ============================================================

function validateRates(rates) {

    const rules = {

        USD:
            [50, 150],

        USD_IDUBID:
            [50, 150],

        JPY:
            [0.1, 2],

        JPY_SWIFT:
            [0.1, 2],

        JPY_AFA:
            [10, 100],

        JPY_QR:
            [10, 100],

        KRW:
            [0.001, 1],

        AED:
            [5, 50],

        THB:
            [0.1, 10],

        CNY:
            [1, 30]
    };


    let valid =
        0;


    for (
        const [key, value] of
        Object.entries(rates)
    ) {

        if (
            !rules[key]
        ) {
            continue;
        }


        const [
            min,
            max
        ] =
            rules[key];


        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < min ||
            value > max
        ) {

            console.log(
                `❌ Подозрительный ${key}: ${value}`
            );

            return false;
        }


        valid++;
    }


    /*
        Для картинки с курсами
        должно быть минимум 6 валидных значений.
    */

    if (
        valid < 6
    ) {

        console.log(
            `❌ Слишком мало курсов: ${valid}`
        );

        return false;
    }


    /*
        Критические значения.
    */

    if (
        rates.USD === undefined ||
        rates.JPY === undefined ||
        rates.AED === undefined ||
        rates.THB === undefined ||
        rates.CNY === undefined
    ) {

        console.log(
            '❌ Не найдены основные курсы'
        );

        return false;
    }


    return true;
}


// ============================================================
// PROCESS POST
// ============================================================

async function processPost(post) {

    console.log('');
    console.log(
        '======================================'
    );

    console.log(
        `📰 Обрабатываем пост #${post.id}`
    );

    console.log(
        `📅 Дата: ${post.date || '-'}`
    );

    console.log(
        '======================================'
    );


    if (
        !post.imageUrl
    ) {

        console.log(
            '⚠️ У поста нет картинки'
        );

        return null;
    }


    try {

        // Скачать
        const originalImage =
            await downloadImage(
                post.imageUrl
            );


        // Улучшить
        const preparedImage =
            await preprocessImage(
                originalImage
            );


        // OCR
        const text =
            await recognizeImage(
                preparedImage
            );


        if (
            !text ||
            text.trim().length < 10
        ) {

            console.log(
                '❌ OCR вернул слишком мало текста'
            );

            return null;
        }


        // Parse
        const rates =
            extractRatesFromText(
                text
            );


        // Validate
        if (
            !validateRates(
                rates
            )
        ) {

            console.log(
                '❌ Курсы не прошли validation'
            );

            return null;
        }


        console.log(
            '🎉 Пост успешно распознан!'
        );


        return {

            rates,

            text
        };

    } catch (error) {

        console.error(
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

    /*
        Если уже идёт обновление,
        второй запрос ждёт первый.
    */

    if (
        updatePromise
    ) {

        return updatePromise;
    }


    updatePromise =
        (async () => {

            try {

                console.log('');
                console.log(
                    '######################################'
                );

                console.log(
                    '🔄 ПОИСК НОВЫХ КУРСОВ'
                );

                console.log(
                    '######################################'
                );


                const posts =
                    await getLatestPosts();


                /*
                    Только посты с изображением.
                */

                const candidates =
                    posts

                        .filter(
                            post =>
                                Boolean(
                                    post.imageUrl
                                )
                        )

                        .slice(
                            0,
                            MAX_POSTS_TO_CHECK
                        );


                if (
                    !candidates.length
                ) {

                    throw new Error(
                        'Нет последних постов с изображениями'
                    );
                }


                /*
                    Идём от самого нового
                    к старым.
                */

                for (
                    const post of candidates
                ) {

                    /*
                        Если пост уже обработан,
                        дальше старые посты не нужны.

                        Но при force=true
                        проверяем его снова.
                    */

                    if (
                        !force &&
                        state.postId &&
                        post.id ===
                        Number(state.postId)
                    ) {

                        console.log(
                            `ℹ️ Пост #${post.id} уже обработан`
                        );


                        return {

                            ...state,

                            source:
                                'cache'
                        };
                    }


                    /*
                        Если пост старее уже сохранённого,
                        пропускаем его.

                        Это важно, чтобы после появления
                        нового поста мы случайно не вернулись
                        к старому.
                    */

                    if (
                        !force &&
                        state.postId &&
                        post.id <
                        Number(state.postId)
                    ) {

                        console.log(
                            `⏭️ Пост #${post.id} старее #${state.postId}`
                        );

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


                    /*
                        УСПЕШНО.
                    */

                    state = {

                        rates:
                            result.rates,

                        postId:
                            post.id,

                        postUrl:
                            post.imageUrl,

                        publishedAt:
                            post.date,

                        recognizedText:
                            result.text,

                        updatedAt:
                            new Date().toISOString(),

                        source:
                            'ocr'
                    };


                    saveState();


                    console.log('');
                    console.log(
                        '======================================'
                    );

                    console.log(
                        '🎉 НОВЫЕ КУРСЫ СОХРАНЕНЫ'
                    );

                    console.log(
                        `📰 Пост #${post.id}`
                    );

                    console.log(
                        state.rates
                    );

                    console.log(
                        '======================================'
                    );


                    return state;
                }


                /*
                    Нового валидного курса нет.
                */

                if (
                    state.rates
                ) {

                    console.log(
                        '📦 Используем последние рабочие курсы'
                    );


                    return {

                        ...state,

                        source:
                            'stale-cache'
                    };
                }


                throw new Error(
                    'Не удалось получить валидные курсы'
                );

            } finally {

                updatePromise =
                    null;
            }

        })();


    return updatePromise;
}


// ============================================================
// API /rates
// ============================================================

app.get(
    '/api/rates',
    async (req, res) => {

        try {

            const now =
                Date.now();


            /*
                Если проверяли недавно —
                возвращаем память.
            */

            if (
                state.rates &&
                lastCheckTime &&
                now - lastCheckTime <
                    CHECK_INTERVAL
            ) {

                return res.json({

                    success:
                        true,

                    rates:
                        state.rates,

                    source:
                        'cache',

                    post:
                        state.postId,

                    date:
                        state.publishedAt,

                    updatedAt:
                        state.updatedAt
                });
            }


            lastCheckTime =
                now;


            const result =
                await updateRates(
                    false
                );


            return res.json({

                success:
                    true,

                rates:
                    result.rates,

                source:
                    result.source,

                post:
                    result.postId,

                date:
                    result.publishedAt,

                updatedAt:
                    result.updatedAt
            });

        } catch (error) {

            console.error(
                '❌ /api/rates:',
                error.message
            );


            /*
                Telegram/OCR упал —
                отдаём старые курсы.
            */

            if (
                state.rates
            ) {

                return res.json({

                    success:
                        true,

                    rates:
                        state.rates,

                    source:
                        'stale-cache',

                    post:
                        state.postId,

                    date:
                        state.publishedAt,

                    updatedAt:
                        state.updatedAt,

                    warning:
                        error.message
                });
            }


            return res.status(500)
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

            lastCheckTime =
                0;


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
                    result.publishedAt,

                updatedAt:
                    result.updatedAt
            });

        } catch (error) {

            console.error(
                '❌ FORCE REFRESH:',
                error.message
            );


            if (
                state.rates
            ) {

                return res.json({

                    success:
                        true,

                    rates:
                        state.rates,

                    source:
                        'stale-cache',

                    post:
                        state.postId,

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
// DEBUG
// ============================================================

app.get(
    '/api/debug',
    (req, res) => {

        res.json({

            channel:
                CHANNEL,

            telegramUrl:
                TELEGRAM_URL,

            state,

            lastCheckTime,

            posts:
                lastTelegramPosts.map(
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
                            post.imageUrl,

                        hasRateWords:
                            post.hasRateWords,

                        text:
                            post.text.substring(
                                0,
                                500
                            )
                    })
                )
        });
    }
);


// ============================================================
// RAW OCR TEST
// ============================================================

/*
    Этот endpoint можно использовать,
    если нужно вручную проверить OCR.

    POST /api/ocr-test

    body:
    {
        "url": "https://..."
    }
*/

app.post(
    '/api/ocr-test',
    async (req, res) => {

        try {

            const {
                url
            } = req.body;


            if (!url) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            'url обязателен'
                    });
            }


            const image =
                await downloadImage(
                    url
                );


            const prepared =
                await preprocessImage(
                    image
                );


            const text =
                await recognizeImage(
                    prepared
                );


            const rates =
                extractRatesFromText(
                    text
                );


            res.json({

                success:
                    true,

                rates,

                valid:
                    validateRates(
                        rates
                    ),

                text
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
// HEALTH
// ============================================================

app.get(
    '/health',
    (req, res) => {

        res.json({

            ok:
                true,

            service:
                'LoyaltySwift OCR',

            postId:
                state.postId,

            hasRates:
                Boolean(
                    state.rates
                ),

            updatedAt:
                state.updatedAt,

            ocr:
                Boolean(worker)
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

<title>
LoyaltySwift OCR
</title>

<style>

body {
    font-family: Arial, sans-serif;
    background: #071116;
    color: white;
    max-width: 900px;
    margin: 40px auto;
    padding: 20px;
}

a {
    color: #00d9ff;
}

.card {
    background: #101d23;
    border-radius: 12px;
    padding: 20px;
    margin: 15px 0;
}

</style>

</head>

<body>

<h1>
🚀 LoyaltySwift OCR Parser
</h1>

<div class="card">

<h2>
API
</h2>

<p>
<a href="/api/rates">
GET /api/rates
</a>
</p>

<p>
<a href="/api/rates/refresh">
GET /api/rates/refresh
</a>
</p>

<p>
<a href="/api/debug">
GET /api/debug
</a>
</p>

<p>
<a href="/health">
GET /health
</a>
</p>

</div>

<div class="card">

<h2>
Текущие данные
</h2>

<pre id="rates">
Загрузка...
</pre>

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
// START
// ============================================================

async function start() {

    try {

        console.log('');
        console.log(
            '============================================'
        );

        console.log(
            '🚀 LoyaltySwift Currency OCR'
        );

        console.log(
            '============================================'
        );

        console.log(
            `📡 Channel: @${CHANNEL}`
        );

        console.log(
            `🌐 Port: ${PORT}`
        );

        console.log(
            `⏱️ Check interval: ${CHECK_INTERVAL / 1000}s`
        );

        console.log(
            `🔎 Max posts: ${MAX_POSTS_TO_CHECK}`
        );

        console.log(
            '============================================'
        );


        await initOCR();


        app.listen(
            PORT,
            () => {

                console.log('');
                console.log(
                    `🚀 Сервер запущен на порту ${PORT}`
                );

                console.log(
                    `💰 http://localhost:${PORT}/api/rates`
                );

                console.log(
                    `🔄 http://localhost:${PORT}/api/rates/refresh`
                );

                console.log(
                    `🐛 http://localhost:${PORT}/api/debug`
                );

                console.log(
                    `❤️ http://localhost:${PORT}/health`
                );

                console.log('');
            }
        );

    } catch (error) {

        console.error(
            '❌ Ошибка запуска:',
            error
        );

        process.exit(1);
    }
}


// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {

    console.log(
        '\n🛑 Остановка сервера...'
    );


    if (worker) {

        try {

            await worker.terminate();

        } catch (error) {

            console.error(
                'Tesseract terminate:',
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
// START
// ============================================================

start();
```
