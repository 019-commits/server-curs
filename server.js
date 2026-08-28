"use strict";

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

const CHANNEL =
    process.env.CHANNEL || "LoyaltySwift";

const TIME_ZONE =
    process.env.TIME_ZONE || "Asia/Almaty";

const CHECK_INTERVAL =
    60 * 1000;

const MAX_POSTS_TO_SCAN =
    40;

const MAX_DAYS_BACK =
    1;

/*
============================================================
ОСНОВНЫЕ КУРСЫ

1. USD
2. USD_IDUBID
3. JPY_SWIFT
4. KRW
5. AED
6. CNY
7. THB

Дополнительные:

JPY_INTERNAL
JPY_AFA_CASH
JPY_AFA_QR
============================================================
*/

const MIN_MAIN_RATES =
    7;

const RATES_FILE =
    path.join(
        __dirname,
        "rates.json"
    );

/*
============================================================
EXPRESS
============================================================
*/

app.use(
    cors({
        origin: "*",
        methods: [
            "GET",
            "HEAD",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Accept",
            "Origin"
        ]
    })
);

app.use(
    express.json({
        limit: "1mb"
    })
);

/*
============================================================
STATE
============================================================
*/

let currentData = null;

let lastSuccessfulData = null;

let isRefreshing = false;

let lastRefreshAt = null;

let lastError = null;

/*
============================================================
LOG
============================================================
*/

function log(...args) {

    console.log(
        `[${new Date().toISOString()}]`,
        ...args
    );
}

/*
============================================================
LOCAL DATE
============================================================
*/

function getLocalDateParts(
    date = new Date()
) {

    const formatter =
        new Intl.DateTimeFormat(
            "en-CA",
            {
                timeZone: TIME_ZONE,
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
            }
        );

    const parts =
        formatter.formatToParts(
            date
        );

    const result = {};

    for (
        const part of parts
    ) {

        if (
            part.type !== "literal"
        ) {

            result[part.type] =
                part.value;
        }
    }

    return {

        year:
            Number(result.year),

        month:
            Number(result.month),

        day:
            Number(result.day)
    };
}

/*
============================================================
DATE KEY
============================================================
*/

function dateKeyFromParts(
    parts
) {

    return [
        String(parts.year)
            .padStart(4, "0"),

        String(parts.month)
            .padStart(2, "0"),

        String(parts.day)
            .padStart(2, "0")
    ].join("-");
}

/*
============================================================
TELEGRAM DATE
============================================================
*/

function telegramDateToLocalKey(
    datetime
) {

    if (!datetime) {
        return null;
    }

    const date =
        new Date(datetime);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return null;
    }

    return dateKeyFromParts(
        getLocalDateParts(date)
    );
}

/*
============================================================
DAYS AGO
============================================================
*/

function getDateKeyDaysAgo(
    days
) {

    const now =
        new Date();

    const parts =
        getLocalDateParts(now);

    const temp =
        new Date(
            Date.UTC(
                parts.year,
                parts.month - 1,
                parts.day
            )
        );

    temp.setUTCDate(
        temp.getUTCDate() - days
    );

    return dateKeyFromParts({

        year:
            temp.getUTCFullYear(),

        month:
            temp.getUTCMonth() + 1,

        day:
            temp.getUTCDate()
    });
}

/*
============================================================
NUMBER
============================================================
*/

function toNumber(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    let str =
        String(value)
            .trim()
            .replace(/\s/g, "")
            .replace(",", ".");

    /*
    OCR иногда делает:

    480.00
    480,00
    480

    */

    const number =
        Number(str);

    if (
        !Number.isFinite(number)
    ) {
        return null;
    }

    return number;
}

/*
============================================================
ROUND
============================================================
*/

function roundRate(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    return Math.round(
        value * 100
    ) / 100;
}

/*
============================================================
OCR NORMALIZE
============================================================
*/

function normalizeOCRText(
    text
) {

    let result =
        String(text || "");

    result =
        result.replace(
            /\r/g,
            "\n"
        );

    result =
        result.replace(
            /[–—−]/g,
            "-"
        );

    /*
    ----------------------------------------------------------
    USD
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /\bU5D\b/gi,
            "USD"
        );

    result =
        result.replace(
            /\bUSO\b/gi,
            "USD"
        );

    result =
        result.replace(
            /\bU5O\b/gi,
            "USD"
        );

    result =
        result.replace(
            /\bUsD\b/g,
            "USD"
        );

    /*
    ----------------------------------------------------------
    JPY
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /\bJpY\b/gi,
            "JPY"
        );

    result =
        result.replace(
            /\bJPV\b/gi,
            "JPY"
        );

    result =
        result.replace(
            /\bJY\b/gi,
            "JPY"
        );

    result =
        result.replace(
            /\b13PY\b/gi,
            "JPY"
        );

    result =
        result.replace(
            /\bI3PY\b/gi,
            "JPY"
        );

    /*
    ----------------------------------------------------------
    AED
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /АЕD/gi,
            "AED"
        );

    result =
        result.replace(
            /AЕD/gi,
            "AED"
        );

    result =
        result.replace(
            /АЕр/gi,
            "AED"
        );

    result =
        result.replace(
            /AЕр/gi,
            "AED"
        );

    /*
    ----------------------------------------------------------
    KRW
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /\bKRVV\b/gi,
            "KRW"
        );

    result =
        result.replace(
            /\bKRV\b/gi,
            "KRW"
        );

    /*
    ----------------------------------------------------------
    THB
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /\bTH8\b/gi,
            "THB"
        );

    result =
        result.replace(
            /\bTHВ\b/gi,
            "THB"
        );

    result =
        result.replace(
            /\bTНB\b/gi,
            "THB"
        );

    result =
        result.replace(
            /\bтнв\b/gi,
            "THB"
        );

    /*
    ----------------------------------------------------------
    CNY
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /\b1eNy\b/gi,
            "1 CNY"
        );

    result =
        result.replace(
            /\beNy\b/gi,
            "CNY"
        );

    result =
        result.replace(
            /\bENY\b/g,
            "CNY"
        );

    /*
    ----------------------------------------------------------
    IDUBID
    ----------------------------------------------------------
    */

    result =
        result.replace(
            /IDUBlD/gi,
            "IDUBID"
        );

    result =
        result.replace(
            /IDUB1D/gi,
            "IDUBID"
        );

    return result;
}

/*
============================================================
FIRST NUMBER
============================================================
*/

function firstNumber(
    text,
    regex
) {

    const match =
        text.match(regex);

    if (!match) {
        return null;
    }

    return toNumber(
        match[1]
    );
}

/*
============================================================
EMPTY RATES
============================================================
*/

function emptyRates() {

    return {

        USD: null,

        USD_IDUBID: null,

        JPY_SWIFT: null,

        JPY_INTERNAL: null,

        JPY_AFA_CASH: null,

        JPY_AFA_QR: null,

        KRW: null,

        AED: null,

        CNY: null,

        THB: null
    };
}

/*
============================================================
EXTRACT RATES
============================================================
*/

function extractRates(
    rawText
) {

    const text =
        normalizeOCRText(
            rawText
        );

    log("");
    log(
        "========== НОРМАЛИЗОВАННЫЙ OCR =========="
    );

    log(text);

    log(
        "=========================================="
    );

    const rates =
        emptyRates();

    /*
    ============================================================
    USD
    ============================================================
    */

    const usdMatches = [];

    const usdRegex =
        /(?:1\s*)?USD\s*=?\s*(\d+(?:[.,]\d+)?)/gi;

    let match;

    while (
        (match =
            usdRegex.exec(text)) !== null
    ) {

        const value =
            toNumber(
                match[1]
            );

        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            usdMatches.push({

                value:
                    roundRate(value),

                index:
                    match.index
            });
        }
    }

    if (
        usdMatches.length >= 1
    ) {

        rates.USD =
            usdMatches[0].value;
    }

    /*
    ============================================================
    USD IDUBID
    ============================================================
    */

    const idubidSection =
        text.match(
            /IDUBID[\s\S]{0,200}/i
        );

    if (
        idubidSection
    ) {

        const value =
            firstNumber(
                idubidSection[0],

                /(?:USD|1)?\s*=?\s*(\d+(?:[.,]\d+)?)/i
            );

        if (
            value !== null &&
            value >= 50 &&
            value <= 150
        ) {

            rates.USD_IDUBID =
                roundRate(value);
        }
    }

    if (
        rates.USD_IDUBID === null &&
        usdMatches.length >= 2
    ) {

        rates.USD_IDUBID =
            usdMatches[1].value;
    }

    /*
    ============================================================
    KRW
    ============================================================
    */

    const krw =
        firstNumber(
            text,

            /(?:1000\s*)?KRW\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

    if (
        krw !== null &&
        krw >= 10 &&
        krw <= 100
    ) {

        rates.KRW =
            roundRate(krw);
    }

    /*
    ============================================================
    AED
    ============================================================
    */

    const aed =
        firstNumber(
            text,

            /(?:1\s*)?AED\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

    if (
        aed !== null &&
        aed >= 5 &&
        aed <= 50
    ) {

        rates.AED =
            roundRate(aed);
    }

    /*
    ============================================================
    CNY
    ============================================================
    */

    let cny =
        firstNumber(
            text,

            /(?:1\s*)?CNY\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

    if (
        cny !== null
    ) {

        if (
            cny > 100
        ) {

            cny =
                cny / 100;
        }

        if (
            cny >= 1 &&
            cny <= 30
        ) {

            rates.CNY =
                roundRate(cny);
        }
    }

    /*
    ============================================================
    THB
    ============================================================
    */

    let thb =
        firstNumber(
            text,

            /(?:1\s*)?THB\s*=?\s*(\d+(?:[.,]\d+)?)/i
        );

    if (
        thb !== null
    ) {

        if (
            thb >= 0.1 &&
            thb <= 10
        ) {

            rates.THB =
                roundRate(thb);
        }
    }

    /*
    ============================================================
    JPY 100
    ============================================================
    */

    const jpy100Matches = [];

    const jpy100Regex =
        /100\s*JPY\s*=?\s*(\d+(?:[.,]\d+)?)/gi;

    while (
        (match =
            jpy100Regex.exec(text)) !== null
    ) {

        const value =
            toNumber(
                match[1]
            );

        if (
            value !== null &&
            value >= 10 &&
            value <= 100
        ) {

            jpy100Matches.push(
                roundRate(value)
            );
        }
    }

    if (
        jpy100Matches.length >= 1
    ) {

        rates.JPY_SWIFT =
            jpy100Matches[0];

        rates.JPY_INTERNAL =
            jpy100Matches[0];
    }

    if (
        jpy100Matches.length >= 2
    ) {

        rates.JPY_INTERNAL =
            jpy100Matches[1];
    }

    /*
    ============================================================
    AFA JPY
    ============================================================
    */

    const afaMatches = [];

    const afaRegex =
        /(?:1\s*)?JPY\s*=?\s*(\d+(?:[.,]\d+)?)/gi;

    while (
        (match =
            afaRegex.exec(text)) !== null
    ) {

        let value =
            toNumber(
                match[1]
            );

        if (
            value === null
        ) {
            continue;
        }

        if (
            value >= 1000 &&
            value <= 10000
        ) {

            value =
                value / 100;
        }

        if (
            value >= 10 &&
            value <= 100
        ) {

            afaMatches.push(
                roundRate(value)
            );
        }
    }

    const uniqueAfa =
        [...new Set(afaMatches)];

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

    if (
        rates.JPY_AFA_CASH !== null &&
        rates.JPY_AFA_QR === null
    ) {

        rates.JPY_AFA_QR =
            rates.JPY_AFA_CASH;
    }

    /*
    ============================================================
    RESULT
    ============================================================
    */

    log("");
    log(
        "💰 РЕЗУЛЬТАТ OCR:"
    );

    console.log(
        JSON.stringify(
            rates,
            null,
            2
        )
    );

    log(
        `📊 Найдено курсов: ${countRates(rates)}/10`
    );

    log(
        `📊 Основных курсов: ${countMainRates(rates)}/7`
    );

    return rates;
}

/*
============================================================
COUNT ALL
============================================================
*/

function countRates(
    rates
) {

    if (!rates) {
        return 0;
    }

    return Object.values(
        rates
    )
        .filter(
            value =>
                value !== null &&
                Number.isFinite(value)
        )
        .length;
}

/*
============================================================
COUNT MAIN
============================================================
*/

function countMainRates(
    rates
) {

    if (!rates) {
        return 0;
    }

    const mainKeys = [

        "USD",

        "USD_IDUBID",

        "JPY_SWIFT",

        "KRW",

        "AED",

        "CNY",

        "THB"
    ];

    return mainKeys
        .filter(
            key =>
                rates[key] !== null &&
                Number.isFinite(
                    rates[key]
                )
        )
        .length;
}

/*
============================================================
VALIDATE
============================================================
*/

function validateRates(
    rates
) {

    if (!rates) {
        return false;
    }

    const total =
        countRates(rates);

    const main =
        countMainRates(rates);

    log(
        `🔎 Проверка курсов: ${total}/10`
    );

    log(
        `🔎 Основных курсов: ${main}/7`
    );

    /*
    ------------------------------------------------------------
    Все 7 основных курсов обязательны.
    ------------------------------------------------------------
    */

    if (
        main < MIN_MAIN_RATES
    ) {

        log(
            `❌ Недостаточно основных курсов: ${main}/7`
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    USD
    ------------------------------------------------------------
    */

    if (
        rates.USD === null ||
        rates.USD < 50 ||
        rates.USD > 150
    ) {

        log(
            "❌ Неверный USD"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    USD IDUBID
    ------------------------------------------------------------
    */

    if (
        rates.USD_IDUBID === null ||
        rates.USD_IDUBID < 50 ||
        rates.USD_IDUBID > 150
    ) {

        log(
            "❌ Неверный USD_IDUBID"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    JPY SWIFT
    ------------------------------------------------------------
    */

    if (
        rates.JPY_SWIFT === null ||
        rates.JPY_SWIFT < 10 ||
        rates.JPY_SWIFT > 100
    ) {

        log(
            "❌ Неверный JPY_SWIFT"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    KRW
    ------------------------------------------------------------
    */

    if (
        rates.KRW === null ||
        rates.KRW < 10 ||
        rates.KRW > 100
    ) {

        log(
            "❌ Неверный KRW"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    AED
    ------------------------------------------------------------
    */

    if (
        rates.AED === null ||
        rates.AED < 5 ||
        rates.AED > 50
    ) {

        log(
            "❌ Неверный AED"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    CNY
    ------------------------------------------------------------
    */

    if (
        rates.CNY === null ||
        rates.CNY < 1 ||
        rates.CNY > 30
    ) {

        log(
            "❌ Неверный CNY"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    THB
    ------------------------------------------------------------
    */

    if (
        rates.THB === null ||
        rates.THB < 0.1 ||
        rates.THB > 10
    ) {

        log(
            "❌ Неверный THB"
        );

        return false;
    }

    /*
    ------------------------------------------------------------
    OPTIONAL JPY
    ------------------------------------------------------------
    */

    const optionalJpy = [

        rates.JPY_INTERNAL,

        rates.JPY_AFA_CASH,

        rates.JPY_AFA_QR
    ];

    for (
        const value of optionalJpy
    ) {

        if (
            value !== null &&
            (
                value < 10 ||
                value > 100
            )
        ) {

            log(
                "❌ Неверный дополнительный JPY"
            );

            return false;
        }
    }

    log(
        "✅ Курсы прошли проверку"
    );

    return true;
}

/*
============================================================
COMPARE
============================================================
*/

function looksReasonable(
    newRates,
    oldRates
) {

    if (!oldRates) {
        return true;
    }

    const important = [

        "USD",

        "USD_IDUBID",

        "JPY_SWIFT",

        "KRW",

        "AED",

        "CNY",

        "THB"
    ];

    for (
        const key of important
    ) {

        const oldValue =
            oldRates[key];

        const newValue =
            newRates[key];

        if (
            oldValue === null ||
            oldValue === undefined ||
            newValue === null ||
            newValue === undefined
        ) {

            continue;
        }

        const ratio =
            newValue / oldValue;

        if (
            ratio > 3 ||
            ratio < 0.333
        ) {

            log(
                `❌ Подозрительный скачок ${key}: ${oldValue} → ${newValue}`
            );

            return false;
        }
    }

    return true;
}

/*
============================================================
PARSE TELEGRAM
============================================================
*/

function parseTelegramPosts(
    html
) {

    const $ =
        cheerio.load(html);

    const posts = [];

    $(".tgme_widget_message")
        .each(
            (_, element) => {

                const item =
                    $(element);

                const dataPost =
                    item.attr(
                        "data-post"
                    );

                if (!dataPost) {
                    return;
                }

                const parts =
                    dataPost.split("/");

                const username =
                    parts[0];

                const id =
                    Number(parts[1]);

                if (
                    !Number.isFinite(id)
                ) {

                    return;
                }

                /*
                ------------------------------------------------
                DATE
                ------------------------------------------------
                */

                const timeElement =
                    item.find(
                        "time"
                    ).first();

                const datetime =
                    timeElement.attr(
                        "datetime"
                    ) || null;

                const dateKey =
                    telegramDateToLocalKey(
                        datetime
                    );

                /*
                ------------------------------------------------
                TEXT
                ------------------------------------------------
                */

                const text =
                    item
                        .find(
                            ".tgme_widget_message_text"
                        )
                        .text()
                        .trim();

                /*
                ------------------------------------------------
                IMAGE
                ------------------------------------------------
                */

                let imageUrl =
                    null;

                const photo =
                    item
                        .find(
                            ".tgme_widget_message_photo_wrap"
                        )
                        .first();

                if (
                    photo.length
                ) {

                    const style =
                        photo.attr(
                            "style"
                        ) || "";

                    const imageMatch =
                        style.match(
                            /background-image\s*:\s*url\((['"]?)(.*?)\1\)/i
                        );

                    if (
                        imageMatch &&
                        imageMatch[2]
                    ) {

                        imageUrl =
                            imageMatch[2]
                                .replace(
                                    /&amp;/g,
                                    "&"
                                )
                                .replace(
                                    /&quot;/g,
                                    '"'
                                );
                    }
                }

                /*
                ------------------------------------------------
                URL
                ------------------------------------------------
                */

                const url =
                    `https://t.me/${username}/${id}`;

                posts.push({

                    id,

                    username,

                    datetime,

                    dateKey,

                    text,

                    imageUrl,

                    url
                });
            }
        );

    posts.sort(
        (a, b) =>
            b.id - a.id
    );

    return posts;
}

/*
============================================================
TELEGRAM PAGE
============================================================
*/

async function fetchTelegramPage(
    before = null
) {

    let url =
        `https://t.me/s/${CHANNEL}`;

    if (
        before
    ) {

        url +=
            `?before=${encodeURIComponent(before)}`;
    }

    log(
        `🌐 Загружаем Telegram: ${url}`
    );

    const response =
        await axios.get(
            url,
            {

                timeout:
                    20000,

                responseType:
                    "text",

                headers: {

                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",

                    "Accept":
                        "text/html,application/xhtml+xml",

                    "Accept-Language":
                        "ru-RU,ru;q=0.9,en;q=0.8"
                },

                maxContentLength:
                    10 * 1024 * 1024
            }
        );

    return response.data;
}

/*
============================================================
COLLECT POSTS
============================================================
*/

async function collectRecentPosts() {

    const allPosts =
        new Map();

    let before =
        null;

    for (
        let page = 0;
        page < 5;
        page++
    ) {

        const html =
            await fetchTelegramPage(
                before
            );

        const posts =
            parseTelegramPosts(
                html
            );

        log(
            `📄 Страница ${page + 1}: найдено ${posts.length} постов`
        );

        if (
            posts.length === 0
        ) {

            break;
        }

        for (
            const post of posts
        ) {

            allPosts.set(
                post.id,
                post
            );
        }

        const oldest =
            posts[
                posts.length - 1
            ];

        if (!oldest) {
            break;
        }

        if (
            before === oldest.id
        ) {

            break;
        }

        before =
            oldest.id;

        const oldestDate =
            new Date(
                oldest.datetime
            );

        if (
            !Number.isNaN(
                oldestDate.getTime()
            )
        ) {

            const oldestKey =
                telegramDateToLocalKey(
                    oldest.datetime
                );

            let tooOld =
                true;

            for (
                let d = 0;
                d <= MAX_DAYS_BACK;
                d++
            ) {

                if (
                    oldestKey ===
                    getDateKeyDaysAgo(d)
                ) {

                    tooOld = false;

                    break;
                }
            }

            if (
                tooOld
            ) {

                break;
            }
        }
    }

    return [
        ...allPosts.values()
    ]
        .sort(
            (a, b) =>
                b.id - a.id
        )
        .slice(
            0,
            MAX_POSTS_TO_SCAN
        );
}

/*
============================================================
DOWNLOAD IMAGE
============================================================
*/

async function downloadImage(
    imageUrl
) {

    if (!imageUrl) {

        throw new Error(
            "У поста нет URL картинки"
        );
    }

    let url;

    try {

        url =
            new URL(
                imageUrl
            ).toString();

    } catch (error) {

        throw new Error(
            `Некорректный URL картинки: ${imageUrl}`
        );
    }

    log(
        "📥 Скачиваем картинку..."
    );

    log(
        `🔗 ${url.substring(0, 150)}...`
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
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",

                    "Referer":
                        `https://t.me/s/${CHANNEL}`,

                    "Accept":
                        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                }
            }
        );

    const buffer =
        Buffer.from(
            response.data
        );

    if (
        buffer.length < 1000
    ) {

        throw new Error(
            "Telegram вернул слишком маленький файл"
        );
    }

    log(
        `✅ Картинка скачана: ${buffer.length} bytes`
    );

    return buffer;
}

/*
============================================================
PREPARE IMAGE
============================================================
*/

async function prepareImage(
    buffer
) {

    log(
        "🖼 Улучшаем изображение перед OCR..."
    );

    const image =
        await sharp(buffer)
            .rotate()
            .resize({

                width:
                    2400,

                withoutEnlargement:
                    false
            })
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();

    log(
        `✅ Изображение подготовлено: ${image.length} bytes`
    );

    return image;
}

/*
============================================================
OCR WORKER
============================================================
*/

let ocrWorker =
    null;

let ocrWorkerPromise =
    null;

async function getOCRWorker() {

    if (
        ocrWorker
    ) {

        return ocrWorker;
    }

    if (
        ocrWorkerPromise
    ) {

        return ocrWorkerPromise;
    }

    ocrWorkerPromise =
        (async () => {

            log(
                "🧠 Создаём OCR worker..."
            );

            const worker =
                await Tesseract.createWorker(
                    "rus+eng"
                );

            ocrWorker =
                worker;

            log(
                "✅ OCR worker готов"
            );

            return worker;

        })();

    try {

        return await ocrWorkerPromise;

    } finally {

        ocrWorkerPromise =
            null;
    }
}

/*
============================================================
RECOGNIZE
============================================================
*/

async function recognizeImage(
    buffer
) {

    const prepared =
        await prepareImage(
            buffer
        );

    const worker =
        await getOCRWorker();

    log(
        "🔍 Запускаем OCR..."
    );

    const result =
        await worker.recognize(
            prepared
        );

    const text =
        result &&
        result.data
            ? result.data.text
            : "";

    if (
        !text.trim()
    ) {

        throw new Error(
            "OCR не вернул текст"
        );
    }

    return text;
}

/*
============================================================
PROCESS POST
============================================================
*/

async function processPost(
    post,
    previousRates
) {

    log("");
    log(
        "=========================================="
    );

    log(
        `📌 ПРОВЕРЯЕМ ПОСТ #${post.id}`
    );

    log(
        `📅 Дата: ${post.dateKey}`
    );

    log(
        `🔗 ${post.url}`
    );

    /*
    ==========================================================
    TEXT
    ==========================================================
    */

    if (
        post.text &&
        post.text.length > 5
    ) {

        log(
            "📝 В посте есть текст — пробуем без OCR"
        );

        const textRates =
            extractRates(
                post.text
            );

        if (
            validateRates(
                textRates
            ) &&
            looksReasonable(
                textRates,
                previousRates
            )
        ) {

            log(
                "🎉 Курсы получены напрямую из текста!"
            );

            return {

                rates:
                    textRates,

                source:
                    "telegram-text",

                ocrText:
                    post.text,

                post
            };
        }
    }

    /*
    ==========================================================
    IMAGE
    ==========================================================
    */

    if (
        !post.imageUrl
    ) {

        log(
            "⚠️ В посте нет картинки"
        );

        return null;
    }

    try {

        const image =
            await downloadImage(
                post.imageUrl
            );

        const ocrText =
            await recognizeImage(
                image
            );

        log("");
        log(
            "========== OCR TEXT =========="
        );

        console.log(
            ocrText
        );

        log(
            "=============================="
        );

        const rates =
            extractRates(
                ocrText
            );

        const valid =
            validateRates(
                rates
            );

        if (!valid) {

            log(
                `❌ Пост #${post.id}: плохой OCR (${countRates(rates)}/10, основных ${countMainRates(rates)}/7)`
            );

            return null;
        }

        if (
            !looksReasonable(
                rates,
                previousRates
            )
        ) {

            log(
                `❌ Пост #${post.id}: подозрительное изменение курсов`
            );

            return null;
        }

        log(
            `🎉 Пост #${post.id}: курсы успешно распознаны`
        );

        return {

            rates,

            source:
                "telegram-ocr",

            ocrText,

            post
        };

    } catch (error) {

        log(
            `❌ Ошибка поста #${post.id}: ${error.message}`
        );

        return null;
    }
}

/*
============================================================
FIND LATEST RATES
============================================================
*/

async function findLatestRates() {

    log("");
    log(
        "=========================================="
    );

    log(
        "🔄 НАЧИНАЕМ ПОИСК НОВЫХ КУРСОВ"
    );

    log(
        "=========================================="
    );

    const today =
        getDateKeyDaysAgo(0);

    log(
        `📅 Сегодня: ${today}`
    );

    const posts =
        await collectRecentPosts();

    log(
        `📊 Всего собрано постов: ${posts.length}`
    );

    const postsByDate =
        new Map();

    for (
        const post of posts
    ) {

        if (
            !post.dateKey
        ) {
            continue;
        }

        if (
            !postsByDate.has(
                post.dateKey
            )
        ) {

            postsByDate.set(
                post.dateKey,
                []
            );
        }

        postsByDate
            .get(
                post.dateKey
            )
            .push(
                post
            );
    }

    const previousRates =
        lastSuccessfulData
            ? lastSuccessfulData.rates
            : null;

    for (
        let day = 0;
        day <= MAX_DAYS_BACK;
        day++
    ) {

        const dateKey =
            getDateKeyDaysAgo(
                day
            );

        const datePosts =
            postsByDate.get(
                dateKey
            ) || [];

        log("");
        log(
            `📅 ${dateKey}: ${datePosts.length} постов`
        );

        if (
            datePosts.length === 0
        ) {
            continue;
        }

        datePosts.sort(
            (a, b) =>
                b.id - a.id
        );

        for (
            const post of datePosts
        ) {

            if (
                !post.imageUrl &&
                !post.text
            ) {
                continue;
            }

            const result =
                await processPost(
                    post,
                    previousRates
                );

            if (
                result
            ) {

                log("");
                log(
                    `✅ НАЙДЕН РАБОЧИЙ ПОСТ #${post.id}`
                );

                log(
                    `📅 Дата: ${dateKey}`
                );

                log(
                    `📊 Курсов: ${countRates(result.rates)}/10`
                );

                log(
                    `📊 Основных: ${countMainRates(result.rates)}/7`
                );

                return result;
            }
        }

        log(
            `⚠️ В ${dateKey} подходящего поста с курсами не найдено`
        );
    }

    return null;
}

/*
============================================================
SAVE
============================================================
*/

function saveRatesToFile(
    data
) {

    try {

        fs.writeFileSync(
            RATES_FILE,

            JSON.stringify(
                data,
                null,
                2
            ),

            "utf8"
        );

        log(
            `💾 rates.json сохранён: ${RATES_FILE}`
        );

        return true;

    } catch (error) {

        log(
            `❌ Ошибка сохранения rates.json: ${error.message}`
        );

        return false;
    }
}

/*
============================================================
LOAD
============================================================
*/

function loadRatesFromFile() {

    try {

        if (
            !fs.existsSync(
                RATES_FILE
            )
        ) {

            log(
                "ℹ️ rates.json пока не существует"
            );

            return null;
        }

        const raw =
            fs.readFileSync(
                RATES_FILE,
                "utf8"
            );

        if (
            !raw.trim()
        ) {

            return null;
        }

        const data =
            JSON.parse(
                raw
            );

        if (
            !data ||
            !data.rates
        ) {

            log(
                "⚠️ rates.json существует, но данные некорректны"
            );

            return null;
        }

        if (
            !validateRates(
                data.rates
            )
        ) {

            log(
                "⚠️ Курсы из rates.json не прошли проверку"
            );

            return null;
        }

        log("");
        log(
            "=========================================="
        );

        log(
            "💾 ЗАГРУЖАЕМ КУРСЫ ИЗ rates.json"
        );

        log(
            `📌 Пост: #${data.post || "unknown"}`
        );

        log(
            `📅 Дата: ${data.postDate || "unknown"}`
        );

        log(
            `📊 Курсов: ${countRates(data.rates)}/10`
        );

        log(
            `📊 Основных: ${countMainRates(data.rates)}/7`
        );

        log(
            "=========================================="
        );

        lastSuccessfulData =
            data;

        currentData =
            data;

        return data;

    } catch (error) {

        log(
            `❌ Ошибка чтения rates.json: ${error.message}`
        );

        return null;
    }
}

/*
============================================================
REFRESH
============================================================
*/

async function refreshRates() {

    if (
        isRefreshing
    ) {

        log(
            "⏳ Обновление уже идёт"
        );

        return;
    }

    isRefreshing =
        true;

    lastRefreshAt =
        new Date().toISOString();

    try {

        const result =
            await findLatestRates();

        if (
            result
        ) {

            const data = {

                success:
                    true,

                rates:
                    result.rates,

                post:
                    result.post.id,

                postUrl:
                    result.post.url,

                postDate:
                    result.post.dateKey,

                source:
                    result.source,

                updatedAt:
                    new Date().toISOString(),

                ocrText:
                    result.ocrText,

                fallback:
                    false
            };

            currentData =
                data;

            lastSuccessfulData =
                data;

            lastError =
                null;

            saveRatesToFile(
                data
            );

            log("");
            log(
                "🎉 НОВЫЕ КУРСЫ ПОЛУЧЕНЫ!"
            );

            log(
                JSON.stringify(
                    data.rates,
                    null,
                    2
                )
            );

            log(
                `📊 Основных курсов: ${countMainRates(data.rates)}/7`
            );

            log(
                `📊 Всего курсов: ${countRates(data.rates)}/10`
            );

        } else {

            lastError =
                "Новых подходящих курсов не найдено";

            if (
                lastSuccessfulData
            ) {

                currentData = {

                    ...lastSuccessfulData,

                    fallback:
                        true,

                    fallbackReason:
                        "Новый пост с курсами не найден",

                    checkedAt:
                        new Date().toISOString()
                };

                log(
                    "⚠️ Новых курсов нет"
                );

                log(
                    `↩️ Используем предыдущие курсы из поста #${lastSuccessfulData.post}`
                );

            } else {

                currentData =
                    null;

                log(
                    "❌ Курсов ещё нет"
                );
            }
        }

    } catch (error) {

        lastError =
            error.message;

        log(
            "❌ Ошибка обновления:",
            error.message
        );

        if (
            lastSuccessfulData
        ) {

            currentData = {

                ...lastSuccessfulData,

                fallback:
                    true,

                fallbackReason:
                    "Ошибка получения новых данных",

                checkedAt:
                    new Date().toISOString()
            };

            log(
                `↩️ Оставляем старые курсы из поста #${lastSuccessfulData.post}`
            );
        }

    } finally {

        isRefreshing =
            false;
    }
}

/*
============================================================
API /api/rates
============================================================
*/

app.get(
    "/api/rates",
    (req, res) => {

        if (
            !currentData
        ) {

            loadRatesFromFile();
        }

        if (
            !currentData
        ) {

            return res
                .status(503)
                .json({

                    success:
                        false,

                    error:
                        "Курсы пока не получены",

                    refreshing:
                        isRefreshing,

                    lastError
                });
        }

        return res.json(
            currentData
        );
    }
);

/*
============================================================
API /api/status
============================================================
*/

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            online:
                true,

            channel:
                CHANNEL,

            timezone:
                TIME_ZONE,

            today:
                getDateKeyDaysAgo(0),

            refreshing:
                isRefreshing,

            lastRefreshAt,

            lastError,

            ratesFile:
                RATES_FILE,

            ratesFileExists:
                fs.existsSync(
                    RATES_FILE
                ),

            post:
                currentData
                    ? currentData.post
                    : null,

            postDate:
                currentData
                    ? currentData.postDate
                    : null,

            ratesFound:
                currentData
                    ? countRates(
                        currentData.rates
                    )
                    : 0,

            mainRatesFound:
                currentData
                    ? countMainRates(
                        currentData.rates
                    )
                    : 0,

            fallback:
                currentData
                    ? !!currentData.fallback
                    : false
        });
    }
);

/*
============================================================
API /api/refresh
============================================================
*/

app.get(
    "/api/refresh",
    async (req, res) => {

        if (
            isRefreshing
        ) {

            return res.json({

                success:
                    false,

                message:
                    "Обновление уже выполняется"
            });
        }

        refreshRates()
            .catch(
                error => {

                    log(
                        "❌ Ошибка ручного refresh:",
                        error.message
                    );
                }
            );

        res.json({

            success:
                true,

            message:
                "Обновление запущено"
        });
    }
);

/*
============================================================
API /api/debug
============================================================
*/

app.get(
    "/api/debug",
    (req, res) => {

        let fileData =
            null;

        try {

            if (
                fs.existsSync(
                    RATES_FILE
                )
            ) {

                fileData =
                    JSON.parse(
                        fs.readFileSync(
                            RATES_FILE,
                            "utf8"
                        )
                    );
            }

        } catch (error) {

            fileData = {

                error:
                    error.message
            };
        }

        res.json({

            currentData,

            lastSuccessfulData,

            ratesFile:
                RATES_FILE,

            ratesFileExists:
                fs.existsSync(
                    RATES_FILE
                ),

            ratesFileData:
                fileData,

            lastError,

            isRefreshing,

            today:
                getDateKeyDaysAgo(0)
        });
    }
);

/*
============================================================
HEALTH
============================================================
*/

app.get(
    "/health",
    (req, res) => {

        res.status(200).json({

            status:
                "ok",

            service:
                "loyaltyswift-rates",

            time:
                new Date().toISOString()
        });
    }
);

/*
============================================================
HOME
============================================================
*/

app.get(
    "/",
    (req, res) => {

        const data =
            currentData;

        const ratesHtml =
            data && data.rates

                ? Object.entries(
                    data.rates
                )
                    .map(
                        ([key, value]) => `

<div class="rate">

    <span>
        ${key}
    </span>

    <span class="value">

        ${
            value === null
                ? "—"
                : value
        }

    </span>

</div>

`
                    )
                    .join("")

                : `

<p class="warning">
    Курсы пока не загружены.
</p>

`;

        const statusText =
            data

                ? (
                    data.fallback
                        ? "Используются предыдущие курсы"
                        : "Курсы актуальны"
                )

                : "Курсы ещё не получены";

        res.send(`
<!DOCTYPE html>

<html lang="ru">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>
    LoyaltySwift Rates
</title>

<style>

* {
    box-sizing:
        border-box;
}

body {

    margin:
        0;

    background:
        #07141b;

    color:
        #ffffff;

    font-family:
        Arial,
        sans-serif;

    padding:
        20px;
}

.container {

    max-width:
        800px;

    margin:
        auto;
}

.card {

    background:
        #102731;

    border:
        1px solid #1f4552;

    border-radius:
        20px;

    padding:
        25px;

    margin-bottom:
        20px;

    box-shadow:
        0 10px 30px
        rgba(0,0,0,.2);
}

h1 {

    margin-top:
        0;

    font-size:
        28px;
}

h2 {

    margin-top:
        0;
}

.rate {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    padding:
        14px 0;

    border-bottom:
        1px solid #24424b;
}

.rate:last-child {

    border-bottom:
        none;
}

.value {

    color:
        #55ddff;

    font-weight:
        bold;

    font-size:
        18px;
}

a {

    display:
        block;

    color:
        #55ddff;

    background:
        #173944;

    padding:
        14px;

    margin-top:
        10px;

    border-radius:
        10px;

    text-decoration:
        none;

    transition:
        .2s;
}

a:hover {

    background:
        #1d4a59;
}

.ok {

    color:
        #51e69b;
}

.warning {

    color:
        #ffd166;
}

.small {

    color:
        #8faab3;

    font-size:
        13px;

    line-height:
        1.7;
}

.badge {

    display:
        inline-block;

    padding:
        6px 10px;

    border-radius:
        20px;

    background:
        #173944;

    color:
        #55ddff;

    font-size:
        12px;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>
    💰 LoyaltySwift Rates
</h1>

<p>
    Канал:
    <b>
        @${CHANNEL}
    </b>
</p>

<p>
    Сегодня:
    <b>
        ${getDateKeyDaysAgo(0)}
    </b>
</p>

<p class="${
    data && !data.fallback
        ? "ok"
        : "warning"
}">

    ${statusText}

</p>

${
    data
        ? `

<p class="small">

Пост:
<b>#${data.post}</b>

<br>

Дата:
<b>${data.postDate}</b>

<br>

Источник:
<b>${data.source}</b>

<br>

Обновлено:
<b>${data.updatedAt}</b>

</p>

`
        : ""
}

</div>

<div class="card">

<h2>
    Курсы
</h2>

${ratesHtml}

</div>

<div class="card">

<h2>
    API
</h2>

<a href="/api/rates">
    📊 /api/rates
</a>

<a href="/api/status">
    ❤️ /api/status
</a>

<a href="/api/refresh">
    🔄 /api/refresh
</a>

<a href="/api/debug">
    🐛 /api/debug
</a>

<a href="/health">
    💚 /health
</a>

</div>

</div>

</body>

</html>
        `);
    }
);

/*
============================================================
START SERVER
============================================================
*/

const server =
    app.listen(
        PORT,
        "0.0.0.0",
        async () => {

            log("");
            log(
                "=========================================="
            );

            log(
                "🚀 LOYALTY SWIFT RATES SERVER"
            );

            log(
                "=========================================="
            );

            log(
                `📡 Порт: ${PORT}`
            );

            log(
                `📢 Канал: @${CHANNEL}`
            );

            log(
                `🕐 Часовой пояс: ${TIME_ZONE}`
            );

            log(
                "📸 OCR: включён"
            );

            log(
                "📅 Поиск по датам: включён"
            );

            log(
                "💾 rates.json: включён"
            );

            log(
                `💾 Файл: ${RATES_FILE}`
            );

            log(
                "↩️ Fallback на старые курсы: включён"
            );

            log(
                "📊 Основных курсов требуется: 7/7"
            );

            log(
                "=========================================="
            );

            /*
            ====================================================
            СНАЧАЛА ЗАГРУЖАЕМ СТАРЫЕ
            ====================================================
            */

            loadRatesFromFile();

            /*
            ====================================================
            ПОТОМ TELEGRAM
            ====================================================
            */

            await refreshRates();

            /*
            ====================================================
            КАЖДЫЕ 60 СЕКУНД
            ====================================================
            */

            setInterval(
                () => {

                    refreshRates()
                        .catch(
                            error => {

                                log(
                                    "❌ Ошибка interval:",
                                    error.message
                                );
                            }
                        );

                },
                CHECK_INTERVAL
            );
        }
    );

/*
============================================================
GRACEFUL SHUTDOWN
============================================================
*/

async function shutdown() {

    log(
        "🛑 Остановка сервера..."
    );

    try {

        if (
            ocrWorker
        ) {

            await ocrWorker.terminate();

            ocrWorker =
                null;
        }

    } catch (error) {

        log(
            "Ошибка остановки OCR:",
            error.message
        );
    }

    try {

        server.close(
            () => {

                process.exit(0);

            }
        );

    } catch (error) {

        process.exit(0);
    }
}

process.on(
    "SIGTERM",
    shutdown
);

process.on(
    "SIGINT",
    shutdown
);
