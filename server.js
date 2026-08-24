'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');


// ============================================================
// CONFIG
// ============================================================

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL = 'LoyaltySwift';

const TELEGRAM_URL =
    `https://t.me/s/${CHANNEL}`;

// Проверяем Telegram каждые 30 секунд
const CHECK_INTERVAL = 30 * 1000;

// Не обрабатываем больше 10 последних постов
const MAX_POSTS = 10;

// Максимальный размер изображения
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(express.json());


// ============================================================
// MEMORY CACHE
// ============================================================

let currentRates = null;

let currentPostId = null;

let currentPostDate = null;

let currentImageUrl = null;

let currentRecognizedText = null;

let lastSuccessfulUpdate = null;

let lastCheck = 0;

let updateInProgress = null;

let ocrWorker = null;


// ============================================================
// HTTP CLIENT
// ============================================================

const http = axios.create({

    timeout: 30000,

    maxRedirects: 5,

    headers: {

        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/131.0.0.0 Safari/537.36',

        'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

        'Accept-Language':
            'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});


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
// INIT OCR
// ============================================================

async function initOCR() {

    if (ocrWorker) {

        return ocrWorker;
    }

    log('🔧 Инициализация Tesseract OCR...');

    ocrWorker =
        await Tesseract.createWorker(
            'rus+eng',
            1,
            {

                logger: function(message) {

                    if (
                        message.status ===
                        'recognizing text'
                    ) {

                        if (
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

                                log(
                                    `🔍 OCR ${percent}%`
                                );
                            }
                        }
                    }
                }
            }
        );


    await ocrWorker.setParameters({

        tessedit_pageseg_mode: '6',

        preserve_interword_spaces: '1'
    });


    log('✅ Tesseract готов');

    return ocrWorker;
}


// ============================================================
// HTML DECODE
// ============================================================

function decodeHtml(value) {

    if (!value) {

        return '';
    }


    return String(value)

        .replace(
            /&amp;/gi,
            '&'
        )

        .replace(
            /&quot;/gi,
            '"'
        )

        .replace(
            /&#39;/gi,
            "'"
        )

        .replace(
            /&lt;/gi,
            '<'
        )

        .replace(
            /&gt;/gi,
            '>'
        );
}


// ============================================================
// HTML -> TEXT
// ============================================================

function htmlToText(html) {

    return decodeHtml(

        String(html)

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
                /[ \t]+/g,
                ' '
            )

            .trim()
    );
}


// ============================================================
// NORMALIZE URL
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

    const result = [];


    let match;


    // --------------------------------------------------------
    // background-image:url(...)
    // --------------------------------------------------------

    const backgroundRegex =
        /background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;


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

            result.push(url);
        }
    }


    // --------------------------------------------------------
    // img src
    // --------------------------------------------------------

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

            result.push(url);
        }
    }


    // --------------------------------------------------------
    // data-src
    // --------------------------------------------------------

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

            result.push(url);
        }
    }


    return [
        ...new Set(result)
    ];
}


// ============================================================
// GET TELEGRAM HTML
// ============================================================

async function getTelegramHTML() {

    log(
        `📡 Проверяем ${TELEGRAM_URL}`
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
            'Telegram не вернул HTML'
        );
    }


    log(
        `✅ Telegram HTML получен: ${response.data.length} символов`
    );


    return response.data;
}


// ============================================================
// PARSE TELEGRAM POSTS
// ============================================================

function parseTelegramPosts(html) {

    const posts = [];

    const regex =
        /<div\b[^>]*data-post=["']LoyaltySwift\/(\d+)["'][^>]*>/gi;


    const starts = [];

    let match;


    while (
        (match = regex.exec(html))
        !== null
    ) {

        starts.push({

            id:
                Number(match[1]),

            index:
                match.index,

            end:
                regex.lastIndex
        });
    }


    if (!starts.length) {

        throw new Error(
            'Telegram: посты канала не найдены'
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
            htmlToText(
                block
            );


        const images =
            extractImageUrls(
                block
            );


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

            images,

            imageUrl:
                images[0] || null
        });
    }


    // Самый большой ID = самый новый пост
    posts.sort(
        (a, b) =>
            b.id - a.id
    );


    // Убираем дубликаты
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
// GET LATEST POSTS
// ============================================================

async function getLatestPosts() {

    const html =
        await getTelegramHTML();


    const posts =
        parseTelegramPosts(
            html
        );


    log(
        `📊 Найдено постов: ${posts.length}`
    );


    for (
        const post of posts.slice(
            0,
            10
        )
    ) {

        log(
            `📰 #${post.id} | ${post.date || '-'} | ` +
            `image=${post.imageUrl ? 'YES' : 'NO'}`
        );
    }


    return posts;
}


// ============================================================
// DOWNLOAD IMAGE
// ============================================================

async function downloadImage(url) {

    if (!url) {

        throw new Error(
            'Пустой URL изображения'
        );
    }


    log(
        '📥 Скачиваем изображение...'
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
                        'AppleWebKit/537.36 Chrome/131.0 Safari/537.36',

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
        buffer.length === 0
    ) {

        throw new Error(
            'Изображение пустое'
        );
    }


    log(
        `✅ Изображение скачано: ${buffer.length} bytes`
    );


    return buffer;
}


// ============================================================
// PREPROCESS IMAGE
// ============================================================

async function preprocessImage(buffer) {

    log(
        '🎨 Подготавливаем изображение для OCR...'
    );


    /*
        Картинки LoyaltySwift обычно вертикальные.

        Увеличиваем размер,
        делаем grayscale,
        повышаем контраст,
        слегка sharpen.
    */

    const result =
        await sharp(buffer)

            .rotate()

            .resize({

                width:
                    2200,

                withoutEnlargement:
                    false,

                fit:
                    'inside'
            })

            .grayscale()

            .normalize()

            .sharpen({

                sigma:
                    1
            })

            .png()

            .toBuffer();


    log(
        `✅ Изображение подготовлено: ${result.length} bytes`
    );


    return result;
}


// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer) {

    const worker =
        await initOCR();


    log(
        '🔍 Запускаем OCR...'
    );


    const result =
        await worker.recognize(
            buffer
        );


    const text =
        result &&
        result.data &&
        result.data.text
            ? result.data.text
            : '';


    log(
        '========== OCR TEXT =========='
    );

    console.log(text);

    log(
        '=============================='
    );


    return text;
}


// ============================================================
// NORMALIZE OCR
// ============================================================

function normalizeOCRText(text) {

    return String(text || '')

        .replace(
            /\r/g,
            '\n'
        )

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

        .replace(
            /[ \t]+/g,
            ' '
        )

        .trim();
}


// ============================================================
// NUMBER
// ============================================================

function parseNumber(value) {

    if (!value) {

        return null;
    }


    const number =
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
        !Number.isFinite(number)
    ) {

        return null;
    }


    return number;
}


// ============================================================
// EXTRACT FIRST RATE
// ============================================================

function findRate(
    text,
    regex
) {

    const match =
        text.match(
            regex
        );


    if (!match) {

        return null;
    }


    return parseNumber(
        match[1]
    );
}


// ============================================================
// EXTRACT RATES
// ============================================================

function extractRates(
    originalText
) {

    const text =
        normalizeOCRText(
            originalText
        );


    const lines =
        text
            .split(/\n+/)
            .map(
                line =>
                    line
                        .replace(
                            /\s+/g,
                            ' '
                        )
                        .trim()
            )
            .filter(Boolean);


    const rates = {};


    // ========================================================
    // USD SWIFT
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findRate(

                line,

                /1\s*USD\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            rates.USD =
                value;

            break;
        }
    }


    // ========================================================
    // JPY SWIFT
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findRate(

                line,

                /100\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            rates.JPY =
                Number(
                    (
                        value / 100
                    ).toFixed(6)
                );

            rates.JPY_SWIFT =
                rates.JPY;

            break;
        }
    }


    // ========================================================
    // KRW
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findRate(

                line,

                /1000\s*KRW\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            rates.KRW =
                Number(
                    (
                        value / 1000
                    ).toFixed(6)
                );

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
            findRate(

                line,

                /1\s*AED\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 5 &&
            value <= 50
        ) {

            rates.AED =
                value;

            break;
        }
    }


    // ========================================================
    // THB
    // ========================================================

    for (
        const line of lines
    ) {

        const value =
            findRate(

                line,

                /1\s*THB\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 0.1 &&
            value <= 10
        ) {

            rates.THB =
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
            findRate(

                line,

                /1\s*CNY\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 1 &&
            value <= 30
        ) {

            rates.CNY =
                value;

            break;
        }
    }


    // ========================================================
    // IDUBID
    // ========================================================

    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const context =
            lines
                .slice(
                    Math.max(
                        0,
                        i - 2
                    ),
                    Math.min(
                        lines.length,
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


        const value =
            findRate(

                context,

                /1\s*USD\s*=\s*(\d+[.,]\d{1,4})/i
            );


        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            rates.USD_IDUBID =
                value;

            break;
        }
    }


    // ========================================================
    // AFA
    // ========================================================

    /*
        В картинке:

        AFA TRADING
        наличные
        1 JPY = 55.80

        AFA TRADING
        QR-code
        1 JPY = 55.30
    */

    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const context =
            lines
                .slice(
                    Math.max(
                        0,
                        i - 3
                    ),
                    Math.min(
                        lines.length,
                        i + 4
                    )
                )
                .join(' ');


        // ----------------------------------------------------
        // CASH
        // ----------------------------------------------------

        if (
            /AFA/i.test(context) &&
            /наличн|cash/i.test(context)
        ) {

            const value =
                findRate(

                    context,

                    /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
                );


            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {

                rates.JPY_AFA =
                    value;
            }
        }


        // ----------------------------------------------------
        // QR
        // ----------------------------------------------------

        if (
            /AFA/i.test(context) &&
            /QR/i.test(context)
        ) {

            const value =
                findRate(

                    context,

                    /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
                );


            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {

                rates.JPY_QR =
                    value;
            }
        }
    }


    // ========================================================
    // AFA FALLBACK
    // ========================================================

    /*
        Если OCR потерял слова "наличные" и "QR",
        ищем все строки:

        1 JPY = xx.xx
    */

    if (
        rates.JPY_AFA === undefined ||
        rates.JPY_QR === undefined
    ) {

        const values = [];


        for (
            const line of lines
        ) {

            const value =
                findRate(

                    line,

                    /1\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i
                );


            if (
                value !== null &&
                value >= 10 &&
                value <= 100
            ) {

                if (
                    !values.includes(value)
                ) {

                    values.push(value);
                }
            }
        }


        if (
            rates.JPY_AFA === undefined &&
            values.length >= 1
        ) {

            rates.JPY_AFA =
                values[0];
        }


        if (
            rates.JPY_QR === undefined &&
            values.length >= 2
        ) {

            rates.JPY_QR =
                values[1];
        }
    }


    // ========================================================
    // LOG
    // ========================================================

    log(
        '📊 Распознанные курсы:',
        rates
    );


    return rates;
}


// ============================================================
// VALIDATE RATES
// ============================================================

function validateRates(
    rates
) {

    const ranges = {

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


    let count = 0;


    for (
        const [
            key,
            value
        ] of Object.entries(
            rates
        )
    ) {

        if (
            !ranges[key]
        ) {

            continue;
        }


        const [
            min,
            max
        ] =
            ranges[key];


        if (
            typeof value !==
            'number'
        ) {

            return false;
        }


        if (
            !Number.isFinite(
                value
            )
        ) {

            return false;
        }


        if (
            value < min ||
            value > max
        ) {

            log(
                `❌ ${key} имеет подозрительное значение: ${value}`
            );

            return false;
        }


        count++;
    }


    /*
        Для твоей картинки
        ожидается много курсов.

        Минимум 6 защищает от ситуации,
        когда OCR распознал случайный текст.
    */

    if (
        count < 6
    ) {

        log(
            `❌ Слишком мало валидных курсов: ${count}`
        );

        return false;
    }


    return true;
}


// ============================================================
// PROCESS ONE POST
// ============================================================

async function processPost(
    post
) {

    log(
        `\n========== POST #${post.id} ==========`
    );


    if (
        !post.imageUrl
    ) {

        log(
            '⏭️ У поста нет картинки'
        );

        return null;
    }


    try {

        // 1
        const original =
            await downloadImage(
                post.imageUrl
            );


        // 2
        const prepared =
            await preprocessImage(
                original
            );


        // 3
        const text =
            await recognizeImage(
                prepared
            );


        if (
            !text ||
            text.trim().length < 20
        ) {

            log(
                '❌ OCR дал слишком мало текста'
            );

            return null;
        }


        // 4
        const rates =
            extractRates(
                text
            );


        // 5
        if (
            !validateRates(
                rates
            )
        ) {

            log(
                `❌ Пост #${post.id} не прошёл проверку`
            );

            return null;
        }


        log(
            `🎉 Пост #${post.id} успешно распознан`
        );


        return {

            rates,

            text
        };

    } catch (error) {

        log(
            `❌ Ошибка обработки #${post.id}: ${error.message}`
        );

        return null;
    }
}


// ============================================================
// UPDATE
// ============================================================

async function updateRates(
    force = false
) {

    /*
        Если другой запрос уже выполняет OCR,
        просто ждём его.
    */

    if (
        updateInProgress
    ) {

        return updateInProgress;
    }


    updateInProgress =
        (async () => {

            try {

                log(
                    '\n🔄 ПРОВЕРКА НОВЫХ КУРСОВ'
                );


                const posts =
                    await getLatestPosts();


                /*
                    Берём только последние посты
                    с изображениями.
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
                            MAX_POSTS
                        );


                if (
                    candidates.length === 0
                ) {

                    throw new Error(
                        'Нет постов с изображениями'
                    );
                }


                /*
                    Самый новый пост всегда первый.

                    Если он новый —
                    пытаемся обработать его.

                    Если OCR не смог его распознать,
                    пробуем предыдущий.
                */

                for (
                    const post of candidates
                ) {

                    /*
                        Если это уже текущий пост
                        и force не установлен,
                        ничего делать не надо.
                    */

                    if (
                        !force &&
                        currentPostId !== null &&
                        post.id ===
                        currentPostId
                    ) {

                        log(
                            `📦 Пост #${post.id} уже используется`
                        );


                        return {

                            rates:
                                currentRates,

                            postId:
                                currentPostId,

                            postDate:
                                currentPostDate,

                            imageUrl:
                                currentImageUrl,

                            text:
                                currentRecognizedText,

                            source:
                                'cache'
                        };
                    }


                    /*
                        Если пост старее текущего,
                        не откатываемся назад.
                    */

                    if (
                        !force &&
                        currentPostId !== null &&
                        post.id <
                        currentPostId
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


                    // Успешно
                    currentRates =
                        result.rates;

                    currentPostId =
                        post.id;

                    currentPostDate =
                        post.date;

                    currentImageUrl =
                        post.imageUrl;

                    currentRecognizedText =
                        result.text;

                    lastSuccessfulUpdate =
                        new Date().toISOString();


                    log(
                        `\n🎉 НОВЫЕ КУРСЫ ПОЛУЧЕНЫ ИЗ ПОСТА #${post.id}`
                    );

                    log(
                        currentRates
                    );


                    return {

                        rates:
                            currentRates,

                        postId:
                            currentPostId,

                        postDate:
                            currentPostDate,

                        imageUrl:
                            currentImageUrl,

                        text:
                            currentRecognizedText,

                        source:
                            'ocr'
                    };
                }


                /*
                    Не нашли новый валидный пост.

                    Но старые рабочие курсы есть.
                */

                if (
                    currentRates
                ) {

                    log(
                        '📦 Нового валидного поста пока нет. Оставляем старые курсы.'
                    );


                    return {

                        rates:
                            currentRates,

                        postId:
                            currentPostId,

                        postDate:
                            currentPostDate,

                        imageUrl:
                            currentImageUrl,

                        text:
                            currentRecognizedText,

                        source:
                            'stale-cache'
                    };
                }


                throw new Error(
                    'Не удалось получить курсы'
                );

            } finally {

                updateInProgress =
                    null;
            }
        })();


    return updateInProgress;
}


// ============================================================
// API /api/rates
// ============================================================

app.get(
    '/api/rates',
    async (req, res) => {

        try {

            const now =
                Date.now();


            /*
                Не запускаем OCR чаще,
                чем раз в 30 секунд.
            */

            if (
                currentRates &&
                lastCheck &&
                now - lastCheck <
                    CHECK_INTERVAL
            ) {

                return res.json({

                    success:
                        true,

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


            lastCheck =
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
                    result.postDate,

                updatedAt:
                    lastSuccessfulUpdate
            });

        } catch (error) {

            log(
                `❌ /api/rates: ${error.message}`
            );


            /*
                Если Telegram временно упал,
                отдаём последние рабочие курсы.
            */

            if (
                currentRates
            ) {

                return res.json({

                    success:
                        true,

                    rates:
                        currentRates,

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

            lastCheck =
                0;


            const result =
                await updateRates(
                    true
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
                    result.postDate,

                updatedAt:
                    lastSuccessfulUpdate
            });

        } catch (error) {

            log(
                `❌ /api/rates/refresh: ${error.message}`
            );


            if (
                currentRates
            ) {

                return res.json({

                    success:
                        true,

                    rates:
                        currentRates,

                    source:
                        'stale-cache',

                    post:
                        currentPostId,

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
// DEBUG
// ============================================================

app.get(
    '/api/debug',
    async (req, res) => {

        try {

            const posts =
                await getLatestPosts();


            res.json({

                success:
                    true,

                channel:
                    CHANNEL,

                telegram:
                    TELEGRAM_URL,

                current: {

                    post:
                        currentPostId,

                    date:
                        currentPostDate,

                    rates:
                        currentRates,

                    updatedAt:
                        lastSuccessfulUpdate
                },

                posts:
                    posts
                        .slice(
                            0,
                            20
                        )
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

        res.status(200)
            .json({

                status:
                    'ok',

                service:
                    'loyaltyswift-rates',

                post:
                    currentPostId,

                hasRates:
                    Boolean(
                        currentRates
                    ),

                ocrReady:
                    Boolean(
                        ocrWorker
                    ),

                updatedAt:
                    lastSuccessfulUpdate,

                time:
                    new Date().toISOString()
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
      content="width=device-width, initial-scale=1.0">

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
    background: #102027;
    border-radius: 16px;
    padding: 25px;
    margin-bottom: 20px;
    box-shadow: 0 10px 30px rgba(0,0,0,.3);
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
OCR parser работает.
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

async function loadRates() {

    try {

        const response =
            await fetch('/api/rates');

        const data =
            await response.json();

        document.getElementById('rates')
            .textContent =
            JSON.stringify(
                data,
                null,
                2
            );

    } catch (error) {

        document.getElementById('rates')
            .textContent =
            error.message;
    }
}

loadRates();

</script>

</body>

</html>

        `);
    }
);


// ============================================================
// BACKGROUND CHECK
// ============================================================

async function backgroundCheck() {

    try {

        log(
            '⏰ Фоновая проверка новых постов...'
        );


        await updateRates(
            false
        );

    } catch (error) {

        log(
            `⚠️ Фоновая проверка: ${error.message}`
        );
    }
}


// ============================================================
// START SERVER
// ============================================================

async function start() {

    log(
        '=========================================='
    );

    log(
        '🚀 LoyaltySwift Rates Server'
    );

    log(
        '=========================================='
    );

    log(
        `📡 Telegram: ${TELEGRAM_URL}`
    );

    log(
        `🌐 Port: ${PORT}`
    );

    log(
        `⏱️ Check: ${CHECK_INTERVAL / 1000}s`
    );


    /*
        OCR инициализируем при старте.

        Это значит, что первый запрос
        не будет ждать загрузки языков.
    */

    try {

        await initOCR();

    } catch (error) {

        log(
            `⚠️ OCR пока не загрузился: ${error.message}`
        );
    }


    app.listen(
        PORT,
        () => {

            log(
                `🚀 Server listening on port ${PORT}`
            );

            log(
                `❤️ Health: /health`
            );

            log(
                `💰 Rates: /api/rates`
            );

            log(
                `🔄 Refresh: /api/rates/refresh`
            );

            log(
                `🐛 Debug: /api/debug`
            );


            /*
                Сразу после запуска
                пробуем получить свежие курсы.
            */

            setTimeout(
                () => {

                    backgroundCheck();

                },
                5000
            );


            /*
                Далее каждые 30 секунд
                проверяем новые посты.
            */

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


    if (
        ocrWorker
    ) {

        try {

            await ocrWorker.terminate();

            log(
                '✅ OCR worker остановлен'
            );

        } catch (error) {

            log(
                `⚠️ Ошибка остановки OCR: ${error.message}`
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
