const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Tesseract = require('tesseract.js');

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL = 'LoyaltySwift';
const TELEGRAM_URL = `https://t.me/s/${CHANNEL}`;

// Проверяем Telegram чаще, но OCR повторно для одного поста не делаем.
const CHECK_INTERVAL = 30 * 1000; // 30 секунд
const CACHE_TTL = 5 * 60 * 1000;   // 5 минут

app.use(cors());
app.use(express.json());


// ============================================================
// STATE
// ============================================================

let cachedRates = null;
let cachedPost = null;
let lastSuccessfulFetch = 0;

// ID самого нового поста, который уже успешно обработали
let lastProcessedPostId = 0;

// Чтобы два запроса одновременно не запускали OCR
let updatePromise = null;

// Для debug
let lastRecognizedText = '';
let lastPosts = [];


// ============================================================
// TESSERACT WORKER
// ============================================================

let ocrWorker = null;
let ocrWorkerPromise = null;

async function getOCRWorker() {
    if (ocrWorker) {
        return ocrWorker;
    }

    if (ocrWorkerPromise) {
        return ocrWorkerPromise;
    }

    console.log('🔧 Создаём Tesseract worker...');

    ocrWorkerPromise = (async () => {
        const worker = await Tesseract.createWorker(
            ['rus', 'eng'],
            1,
            {
                logger: (message) => {
                    if (
                        message.status === 'recognizing text' &&
                        typeof message.progress === 'number'
                    ) {
                        const percent = Math.round(message.progress * 100);

                        if (percent % 10 === 0) {
                            console.log(`🔍 OCR: ${percent}%`);
                        }
                    }
                }
            }
        );

        // Для курсов обычно полезно разрешить цифры,
        // буквы валют и основные символы.
        await worker.setParameters({
            preserve_interword_spaces: '1',
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK
        });

        ocrWorker = worker;

        console.log('✅ Tesseract worker готов');

        return worker;
    })();

    try {
        return await ocrWorkerPromise;
    } finally {
        ocrWorkerPromise = null;
    }
}


// ============================================================
// TELEGRAM HTML
// ============================================================

async function getTelegramHTML() {
    console.log('📡 Загружаем Telegram...');

    const response = await axios.get(TELEGRAM_URL, {
        timeout: 20000,
        responseType: 'text',
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/128.0 Safari/537.36',

            'Accept':
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
        }
    });

    return response.data;
}


// ============================================================
// ESCAPE HTML
// ============================================================

function decodeHtml(text) {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}


// ============================================================
// ПОИСК ПОСТОВ
// ============================================================

function extractPosts(html) {
    const posts = [];

    /*
        Telegram обычно содержит:

        data-post="ChannelName/12345"

        Поэтому ID поста используем как главный критерий
        свежести.
    */

    const postRegex =
        /data-post=["']([^"']+\/(\d+))["']/gi;

    const found = new Map();

    let match;

    while ((match = postRegex.exec(html)) !== null) {
        const fullPost = match[1];
        const postId = Number(match[2]);

        if (!postId) {
            continue;
        }

        // Ищем приблизительно ближайший блок вокруг data-post
        const start = Math.max(0, match.index - 1000);
        const end = Math.min(html.length, match.index + 15000);

        const block = html.substring(start, end);

        // ----------------------------------------------------
        // Ищем изображения
        // ----------------------------------------------------

        const imageUrls = [];

        // background-image:url(...)
        const backgroundRegex =
            /background-image\s*:\s*url\(["']?([^"')\s]+)["']?\)/gi;

        let imageMatch;

        while ((imageMatch = backgroundRegex.exec(block)) !== null) {
            let imageUrl = decodeHtml(imageMatch[1]);

            if (
                imageUrl.startsWith('https://') ||
                imageUrl.startsWith('http://')
            ) {
                imageUrls.push(imageUrl);
            }
        }

        // Обычные <img src="">
        const imgRegex =
            /<img[^>]+src=["']([^"']+)["']/gi;

        while ((imageMatch = imgRegex.exec(block)) !== null) {
            let imageUrl = decodeHtml(imageMatch[1]);

            if (
                imageUrl.startsWith('https://') ||
                imageUrl.startsWith('http://')
            ) {
                imageUrls.push(imageUrl);
            }
        }

        // ----------------------------------------------------
        // Текст поста
        // ----------------------------------------------------

        const textWithoutTags = block
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const hasRateKeywords =
            /КУРС|КУРСЫ|USD|JPY|KRW|AED|THB|CNY|IDUBID/i.test(
                textWithoutTags
            );

        const post = {
            id: postId,
            fullPost,
            url: [...new Set(imageUrls)][0] || null,
            images: [...new Set(imageUrls)],
            text: textWithoutTags,
            hasRateKeywords
        };

        /*
            Если один и тот же пост встретился несколько раз,
            оставляем вариант с картинкой.
        */

        const existing = found.get(postId);

        if (!existing || (!existing.url && post.url)) {
            found.set(postId, post);
        }
    }

    for (const post of found.values()) {
        posts.push(post);
    }

    // Сначала самые новые
    posts.sort((a, b) => b.id - a.id);

    return posts;
}


// ============================================================
// ПОИСК НОВЫХ ПОСТОВ
// ============================================================

async function findLatestPosts() {
    const html = await getTelegramHTML();

    const posts = extractPosts(html);

    console.log(`📊 Найдено постов: ${posts.length}`);

    lastPosts = posts.slice(0, 20);

    if (!posts.length) {
        throw new Error(
            'Telegram не вернул ни одного поста'
        );
    }

    for (const post of posts.slice(0, 10)) {
        console.log(
            `   #${post.id}` +
            ` | image=${post.url ? 'YES' : 'NO'}` +
            ` | rates=${post.hasRateKeywords ? 'YES' : 'NO'}`
        );
    }

    return posts;
}


// ============================================================
// СКАЧИВАНИЕ КАРТИНКИ
// ============================================================

async function downloadImage(url) {
    if (!url) {
        throw new Error('URL картинки отсутствует');
    }

    console.log('📥 Скачиваем изображение:');
    console.log(url);

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 15 * 1024 * 1024,
        maxBodyLength: 15 * 1024 * 1024,

        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 Chrome/128.0 Safari/537.36',

            'Referer': 'https://t.me/'
        }
    });

    const buffer = Buffer.from(response.data);

    console.log(
        `✅ Изображение скачано: ${buffer.length} bytes`
    );

    return buffer;
}


// ============================================================
// OCR
// ============================================================

async function recognizeImage(buffer) {
    const worker = await getOCRWorker();

    console.log('🔍 Начинаем OCR...');

    const result = await worker.recognize(buffer);

    const text = result?.data?.text || '';

    console.log('📄 OCR TEXT:');
    console.log(text);
    console.log('-----------------------------');

    lastRecognizedText = text;

    return text;
}


// ============================================================
// НОРМАЛИЗАЦИЯ OCR
// ============================================================

function normalizeOCRText(text) {
    return text
        .replace(/\r/g, '\n')

        // OCR часто путает эти символы
        .replace(/[–—−]/g, '-')
        .replace(/[：]/g, ':')
        .replace(/[，]/g, ',')
        .replace(/[=≈≡]/g, '=')

        // Убираем лишние пробелы
        .replace(/[ \t]+/g, ' ')

        // Исправляем некоторые частые OCR-ошибки
        .replace(/\bJpY\b/gi, 'JPY')
        .replace(/\bJY\b/gi, 'JPY')
        .replace(/\bU5D\b/gi, 'USD')
        .replace(/\bUSO\b/gi, 'USD')
        .replace(/\bKRVV\b/gi, 'KRW')
        .replace(/\bAE0\b/gi, 'AED')
        .replace(/\bTH8\b/gi, 'THB')

        .trim();
}


// ============================================================
// ЧИСЛО
// ============================================================

function parseNumber(value) {
    if (!value) {
        return null;
    }

    let str = value
        .replace(/\s/g, '')
        .replace(',', '.');

    /*
        OCR может сделать:

        87.20
        87,20
        87
        1 234.56
    */

    const number = Number(str);

    return Number.isFinite(number)
        ? number
        : null;
}


// ============================================================
// ПОИСК ЗНАЧЕНИЯ ПО РЕГЕКСПУ
// ============================================================

function firstNumber(text, regexes) {
    for (const regex of regexes) {
        const match = text.match(regex);

        if (match) {
            const value = parseNumber(match[1]);

            if (value !== null) {
                return value;
            }
        }
    }

    return null;
}


// ============================================================
// EXTRACT RATES
// ============================================================

function extractRatesFromText(originalText) {
    const text = normalizeOCRText(originalText);

    console.log('🧹 Нормализованный OCR:');
    console.log(text);
    console.log('-----------------------------');

    const rates = {};

    // --------------------------------------------------------
    // USD
    // --------------------------------------------------------

    let usd = firstNumber(text, [
        /(?:150|1)\s*(?:USD)?\s*=\s*(\d+[.,]\d{1,4})/i,
        /\bUSD\s*=\s*(\d+[.,]\d{1,4})/i,
        /\bUSD\s*[:\-]\s*(\d+[.,]\d{1,4})/i
    ]);

    if (usd !== null) {
        rates.USD = usd;
    }


    // --------------------------------------------------------
    // JPY
    // --------------------------------------------------------

    let jpy100 = firstNumber(text, [
        /100\s*JPY\s*=\s*(\d+[.,]\d{1,4})/i,
        /100\s*JY\s*=\s*(\d+[.,]\d{1,4})/i
    ]);

    if (jpy100 !== null) {
        rates.JPY = jpy100 / 100;
        rates.JPY_SWIFT = jpy100 / 100;
    }


    // 1 JPY = ...
    const jpyOne = firstNumber(text, [
        /1\s*JPY\s*=\s*(\d+[.,]\d{1,6})/i,
        /1\s*JpY\s*=\s*(\d+[.,]\d{1,6})/i
    ]);

    if (jpyOne !== null) {
        /*
            Если OCR получил 6580 вместо 65.80,
            корректируем.
        */

        const normalized =
            jpyOne > 1000
                ? jpyOne / 100
                : jpyOne;

        rates.JPY_AFA = normalized;
    }


    // --------------------------------------------------------
    // JPY QR
    // --------------------------------------------------------

    if (rates.JPY) {
        rates.JPY_QR = rates.JPY;
    }


    // --------------------------------------------------------
    // KRW
    // --------------------------------------------------------

    const krw1000 = firstNumber(text, [
        /1000\s*KRW\s*=\s*(\d+[.,]\d{1,4})/i,
        /1000\s*KRVV\s*=\s*(\d+[.,]\d{1,4})/i
    ]);

    if (krw1000 !== null) {
        rates.KRW = krw1000 / 1000;
    }


    // --------------------------------------------------------
    // AED
    // --------------------------------------------------------

    const aed = firstNumber(text, [
        /1\s*AED\s*=\s*(\d+[.,]\d{1,4})/i,
        /\bAED\s*=\s*(\d+[.,]\d{1,4})/i,
        /\bAED\s*[:\-]\s*(\d+[.,]\d{1,4})/i
    ]);

    if (aed !== null) {
        rates.AED = aed;
    }


    // --------------------------------------------------------
    // THB
    // --------------------------------------------------------

    const thb = firstNumber(text, [
        /1\s*THB\s*=\s*(\d+[.,]\d{1,4})/i,
        /\bTHB\s*=\s*(\d+[.,]\d{1,4})/i
    ]);

    if (thb !== null) {
        rates.THB =
            thb > 100
                ? thb / 100
                : thb;
    }


    // --------------------------------------------------------
    // CNY
    // --------------------------------------------------------

    const cny = firstNumber(text, [
        /КИТА[ЙИ][^\d]{0,20}(\d+[.,]\d{1,4})/i,
        /\bCNY\s*=\s*(\d+[.,]\d{1,4})/i,
        /\bCNY\s*[:\-]\s*(\d+[.,]\d{1,4})/i
    ]);

    if (cny !== null) {
        rates.CNY = cny;
    }


    // --------------------------------------------------------
    // USD IDUBID
    // --------------------------------------------------------

    const idubid = firstNumber(text, [
        /IDUBID[^\d]{0,20}(\d+[.,]\d{1,4})/i,
        /USD\s*IDUBID[^\d]{0,20}(\d+[.,]\d{1,4})/i
    ]);

    if (idubid !== null) {
        rates.USD_IDUBID = idubid;
    } else if (rates.USD) {
        rates.USD_IDUBID =
            Number((rates.USD + 1.5).toFixed(4));
    }


    console.log('💰 Найденные курсы:');
    console.log(rates);

    return rates;
}


// ============================================================
// ПРОВЕРКА КУРСОВ
// ============================================================

function isValidRates(rates) {
    if (!rates) {
        return false;
    }

    const keys = Object.keys(rates);

    /*
        Не принимаем OCR как успешный,
        если он распознал только мусор.

        Минимум 2 курса.
    */

    if (keys.length < 2) {
        return false;
    }

    for (const key of keys) {
        const value = rates[key];

        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value <= 0
        ) {
            return false;
        }
    }

    return true;
}


// ============================================================
// ОБРАБОТКА ОДНОГО ПОСТА
// ============================================================

async function processPost(post) {
    console.log('');
    console.log('========================================');
    console.log(`📰 Проверяем пост #${post.id}`);
    console.log('========================================');

    if (!post.url) {
        console.log('⚠️ У поста нет картинки');
        return null;
    }

    try {
        const image = await downloadImage(post.url);

        const text = await recognizeImage(image);

        if (!text || text.trim().length < 5) {
            console.log('⚠️ OCR не распознал текст');
            return null;
        }

        const rates = extractRatesFromText(text);

        if (!isValidRates(rates)) {
            console.log(
                '⚠️ Пост содержит недостаточно валидных курсов'
            );

            return null;
        }

        return {
            rates,
            post
        };

    } catch (error) {
        console.error(
            `❌ Ошибка обработки поста #${post.id}:`,
            error.message
        );

        return null;
    }
}


// ============================================================
// ПОЛУЧЕНИЕ САМЫХ НОВЫХ КУРСОВ
// ============================================================

async function updateRates() {
    /*
        Если update уже идёт, второй запрос ждёт первый.
    */

    if (updatePromise) {
        return updatePromise;
    }

    updatePromise = (async () => {
        try {
            console.log('');
            console.log('🔄 Ищем новые курсы...');
            console.log(
                `Последний успешный пост: #${lastProcessedPostId}`
            );

            const posts = await findLatestPosts();

            /*
                Проверяем только последние посты.

                Это важно:
                Telegram может содержать сотни старых постов.
            */

            const candidates = posts
                .filter(post => post.url)
                .slice(0, 10);

            if (!candidates.length) {
                throw new Error(
                    'Не найдено свежих постов с изображениями'
                );
            }

            /*
                ВАЖНО:

                Идём от самого нового к старым.

                Если новый пост — не курсы,
                проверяем следующий.
            */

            for (const post of candidates) {
                console.log(
                    `🔎 Кандидат #${post.id}`
                );

                const result = await processPost(post);

                if (!result) {
                    continue;
                }

                /*
                    Если это тот же самый пост,
                    не нужно заново обновлять данные.
                */

                if (
                    cachedPost &&
                    Number(cachedPost.id) === Number(post.id)
                ) {
                    console.log(
                        `ℹ️ Пост #${post.id} уже был обработан`
                    );

                    return {
                        rates: cachedRates,
                        post: cachedPost,
                        source: 'cache'
                    };
                }

                // --------------------------------------------
                // УСПЕШНО
                // --------------------------------------------

                cachedRates = result.rates;
                cachedPost = {
                    id: post.id,
                    url: post.url
                };

                lastProcessedPostId = post.id;
                lastSuccessfulFetch = Date.now();

                console.log('');
                console.log('🎉 НОВЫЕ КУРСЫ НАЙДЕНЫ!');
                console.log(
                    `📰 Пост: #${post.id}`
                );
                console.log(
                    '💰 Курсы:',
                    result.rates
                );

                return {
                    rates: result.rates,
                    post: cachedPost,
                    source: 'ocr'
                };
            }

            /*
                Если новые посты не нашли,
                возвращаем старый кэш.
            */

            if (cachedRates) {
                console.log(
                    'ℹ️ Нового курса не найдено. Используем cache.'
                );

                return {
                    rates: cachedRates,
                    post: cachedPost,
                    source: 'cache'
                };
            }

            throw new Error(
                'Не удалось найти валидные курсы ни в одном из последних постов'
            );

        } finally {
            updatePromise = null;
        }
    })();

    return updatePromise;
}


// ============================================================
// API /rates
// ============================================================

app.get('/api/rates', async (req, res) => {
    try {
        /*
            Если недавно уже получали курсы,
            всё равно периодически проверяем Telegram.

            Это позволяет автоматически подхватывать новый пост.
        */

        const cacheIsFresh =
            cachedRates &&
            Date.now() - lastSuccessfulFetch < CHECK_INTERVAL;

        if (cacheIsFresh) {
            return res.json({
                success: true,
                rates: cachedRates,
                source: 'cache',
                post: cachedPost?.id || null,
                updatedAt: new Date(
                    lastSuccessfulFetch
                ).toISOString()
            });
        }

        const result = await updateRates();

        return res.json({
            success: true,
            rates: result.rates,
            source: result.source,
            post: result.post?.id || null,
            updatedAt: lastSuccessfulFetch
                ? new Date(
                    lastSuccessfulFetch
                ).toISOString()
                : null
        });

    } catch (error) {
        console.error(
            '❌ /api/rates:',
            error.message
        );

        /*
            Даже при ошибке Telegram/OCR
            отдаём старые рабочие курсы.
        */

        if (cachedRates) {
            return res.json({
                success: true,
                rates: cachedRates,
                source: 'stale-cache',
                post: cachedPost?.id || null,
                warning: error.message
            });
        }

        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// ============================================================
// FORCE UPDATE
// ============================================================

app.get('/api/rates/refresh', async (req, res) => {
    try {
        /*
            Принудительно ищем новые посты.
        */

        lastSuccessfulFetch = 0;

        const result = await updateRates();

        res.json({
            success: true,
            rates: result.rates,
            source: result.source,
            post: result.post?.id || null
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// ============================================================
// DEBUG
// ============================================================

app.get('/api/debug', (req, res) => {
    res.json({
        channel: CHANNEL,

        lastProcessedPostId,

        cachedPost,

        cachedRates,

        posts: lastPosts.map(post => ({
            id: post.id,
            url: post.url,
            images: post.images,
            hasRateKeywords: post.hasRateKeywords,
            text: post.text.substring(0, 500)
        })),

        recognizedText: lastRecognizedText,

        updatedAt: lastSuccessfulFetch
            ? new Date(
                lastSuccessfulFetch
            ).toISOString()
            : null
    });
});


// ============================================================
// HEALTH
// ============================================================

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <meta charset="UTF-8">
                <title>OCR Parser</title>
            </head>

            <body>
                <h1>🚀 OCR Parser курсов</h1>

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
            </body>
        </html>
    `);
});


// ============================================================
// START
// ============================================================

async function start() {
    try {
        console.log('');
        console.log('========================================');
        console.log('🚀 OCR Currency Parser');
        console.log('========================================');
        console.log(`📡 Channel: @${CHANNEL}`);
        console.log(`🌐 Port: ${PORT}`);
        console.log('========================================');

        // Инициализируем OCR заранее
        await getOCRWorker();

        app.listen(PORT, () => {
            console.log(
                `🚀 Сервер запущен: http://localhost:${PORT}`
            );

            console.log(
                `💰 API: http://localhost:${PORT}/api/rates`
            );
        });

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
    console.log('\n🛑 Завершение работы...');

    if (ocrWorker) {
        await ocrWorker.terminate();
        ocrWorker = null;
    }

    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
