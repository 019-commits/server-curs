const express = require('express');
const cors = require('cors');
const Tesseract = require('tesseract.js');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let cachedRates = null;
let lastFetch = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 минуты

// --- Функция для извлечения курсов из распознанного текста ---
function extractRatesFromText(text) {
    console.log('📄 Распознанный текст:');
    console.log(text);
    console.log('---');
    
    const rates = {};
    
    // --- Ищем курсы по точным паттернам ---
    
    // 1. USD SWIFT
    let usdMatch = text.match(/USD[^\d]*?(\d+[.,]\d+)/i);
    if (usdMatch) {
        rates.USD = parseFloat(usdMatch[1].replace(',', '.'));
        console.log(`✅ USD: ${rates.USD}`);
    }
    
    // 2. USD IDUBID
    let idubidMatch = text.match(/IDUBID[^\d]*?(\d+[.,]\d+)/i);
    if (idubidMatch) {
        rates.USD_IDUBID = parseFloat(idubidMatch[1].replace(',', '.'));
        console.log(`✅ USD_IDUBID: ${rates.USD_IDUBID}`);
    }
    
    // 3. CNY
    let cnyMatch = text.match(/КИТАЙ[^\d]*?(\d+[.,]\d+)/i);
    if (cnyMatch) {
        rates.CNY = parseFloat(cnyMatch[1].replace(',', '.'));
        console.log(`✅ CNY: ${rates.CNY}`);
    }
    
    // 4. JPY (внутренний перевод)
    let jpyMatch = text.match(/ЯПОНИЯ[^\d]*?внутренний[^\d]*?(\d+[.,]\d+)/i);
    if (jpyMatch) {
        let val = parseFloat(jpyMatch[1].replace(',', '.'));
        rates.JPY = val > 10 ? val / 100 : val;
        console.log(`✅ JPY: ${rates.JPY} (из ${val})`);
    }
    
    // 5. JPY SWIFT
    let jpySwiftMatch = text.match(/ЯПОНИЯ[^\d]*?SWIFT[^\d]*?(\d+[.,]\d+)/i);
    if (jpySwiftMatch) {
        let val = parseFloat(jpySwiftMatch[1].replace(',', '.'));
        rates.JPY_SWIFT = val > 10 ? val / 100 : val;
        console.log(`✅ JPY_SWIFT: ${rates.JPY_SWIFT} (из ${val})`);
    }
    
    // 6. JPY AFA (наличные)
    let afaMatch = text.match(/AFA[^\d]*?TRADING[^\d]*?наличные[^\d]*?(\d+[.,]\d+)/i);
    if (afaMatch) {
        let val = parseFloat(afaMatch[1].replace(',', '.'));
        rates.JPY_AFA = val > 10 ? val / 100 : val;
        console.log(`✅ JPY_AFA: ${rates.JPY_AFA} (из ${val})`);
    }
    
    // 7. JPY AFA (QR)
    let qrMatch = text.match(/AFA[^\d]*?TRADING[^\d]*?QR[^\d]*?(\d+[.,]\d+)/i);
    if (qrMatch) {
        let val = parseFloat(qrMatch[1].replace(',', '.'));
        rates.JPY_QR = val > 10 ? val / 100 : val;
        console.log(`✅ JPY_QR: ${rates.JPY_QR} (из ${val})`);
    }
    
    // 8. KRW
    let krwMatch = text.match(/ЮЖНАЯ[^\d]*?КОРЕЯ[^\d]*?(\d+[.,]\d+)/i);
    if (krwMatch) {
        let val = parseFloat(krwMatch[1].replace(',', '.'));
        rates.KRW = val > 10 ? val / 1000 : val;
        console.log(`✅ KRW: ${rates.KRW} (из ${val})`);
    }
    
    // 9. AED
    let aedMatch = text.match(/ОАЭ[^\d]*?(\d+[.,]\d+)/i);
    if (aedMatch) {
        rates.AED = parseFloat(aedMatch[1].replace(',', '.'));
        console.log(`✅ AED: ${rates.AED}`);
    }
    
    // 10. THB
    let thbMatch = text.match(/ТАИЛАНД[^\d]*?(\d+[.,]\d+)/i);
    if (thbMatch) {
        rates.THB = parseFloat(thbMatch[1].replace(',', '.'));
        console.log(`✅ THB: ${rates.THB}`);
    }
    
    console.log(`📊 Найдено курсов: ${Object.keys(rates).length}`);
    return rates;
}

// --- Функция для скачивания и распознавания картинки ---
async function downloadAndRecognizeImage(url) {
    try {
        console.log('📥 Скачиваем картинку...');
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        
        const tempFile = '/tmp/telegram_image.jpg';
        fs.writeFileSync(tempFile, response.data);
        
        console.log('🔍 Распознаём текст через OCR...');
        const result = await Tesseract.recognize(tempFile, 'rus+eng', {
            logger: (m) => {
                if (m.status === 'recognizing text' && m.progress) {
                    console.log(`⏳ Распознавание: ${Math.round(m.progress * 100)}%`);
                }
            }
        });
        
        fs.unlinkSync(tempFile);
        return result.data.text;
        
    } catch (error) {
        console.error('❌ Ошибка при распознавании:', error.message);
        return null;
    }
}

// --- ГЛАВНАЯ ФУНКЦИЯ: находим САМЫЙ СВЕЖИЙ ПОСТ с курсами ---
async function fetchAllRates() {
    console.log('🔄 Поиск самого свежего поста с курсами...');
    
    try {
        const response = await fetch('https://t.me/s/LoyaltySwift', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        const posts = [];
        const postRegex = /<div[^>]*data-post="LoyaltySwift\/(\d+)"[^>]*>([\s\S]*?)<div class="tgme_widget_message_footer/g;
        let postMatch;
        
        while ((postMatch = postRegex.exec(html)) !== null) {
            const postId = postMatch[1];
            const content = postMatch[2];
            
            const dateMatch = content.match(/(\d{2}\.\d{2})/);
            const imgMatch = content.match(/background-image:url\('([^']+\.jpg)'\)/);
            
            if (dateMatch && imgMatch) {
                const hasRates = content.includes('КУРС') || content.includes('USD') || content.includes('JPY');
                posts.push({
                    id: postId,
                    date: dateMatch[1],
                    url: imgMatch[1],
                    hasRates: hasRates
                });
            }
        }
        
        console.log(`📊 Найдено ${posts.length} постов с картинками`);
        
        if (posts.length === 0) {
            throw new Error('Не найдено постов с картинками');
        }
        
        posts.sort((a, b) => parseInt(b.id) - parseInt(a.id));
        
        let targetPost = posts.find(p => p.hasRates) || posts[0];
        
        console.log(`✅ Выбран пост #${targetPost.id} от ${targetPost.date}`);
        
        return targetPost;
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        throw error;
    }
}

// --- Эндпоинт ---
app.get('/api/rates', async (req, res) => {
    try {
        const now = Date.now();
        if (cachedRates && (now - lastFetch) < CACHE_TTL) {
            console.log('📦 Возвращаем кеш');
            return res.json({ rates: cachedRates, source: 'cache' });
        }
        
        const post = await fetchAllRates();
        const recognizedText = await downloadAndRecognizeImage(post.url);
        
        if (!recognizedText) {
            return res.status(500).json({ 
                error: 'Не удалось распознать текст с картинки',
                post: post.id,
                date: post.date
            });
        }
        
        const rates = extractRatesFromText(recognizedText);
        
        if (!rates || Object.keys(rates).length === 0) {
            return res.status(500).json({ 
                error: 'Не найдено курсов на картинке',
                post: post.id,
                date: post.date,
                recognized_text: recognizedText.substring(0, 300)
            });
        }
        
        console.log('\n✅ Итоговые курсы (пост от ' + post.date + '):', rates);
        
        cachedRates = rates;
        lastFetch = now;
        res.json({ 
            rates, 
            source: 'ocr',
            post: post.id, 
            date: post.date
        });
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 OCR Парсер курсов</h1>
        <p>Распознаёт курсы ТОЛЬКО с картинок Telegram</p>
        <p><a href="/api/rates">/api/rates</a> - получить курсы</p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log('📸 Только OCR, без резервных курсов');
});
