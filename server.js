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
    console.log('📄 Распознанный текст (первые 500 символов):', text.substring(0, 500));
    
    const rates = {};
    
    // Проверяем, что это картинка с курсами
    if (!text.includes('КУРС') && !text.includes('JPY') && !text.includes('USD')) {
        console.log('⚠️ Это не картинка с курсами');
        return null;
    }
    
    // --- Ищем курсы ---
    let usdMatch = text.match(/USD[^\d]*?(\d+[.,]\d+)/i);
    if (usdMatch) rates.USD = parseFloat(usdMatch[1].replace(',', '.'));
    
    let idubidMatch = text.match(/IDUBID[^\d]*?(\d+[.,]\d+)/i);
    if (idubidMatch) rates.USD_IDUBID = parseFloat(idubidMatch[1].replace(',', '.'));
    
    let cnyMatch = text.match(/КИТАЙ[^\d]*?(\d+[.,]\d+)/i);
    if (cnyMatch) rates.CNY = parseFloat(cnyMatch[1].replace(',', '.'));
    
    let jpyMatch = text.match(/ЯПОНИЯ[^\d]*?внутренний[^\d]*?(\d+[.,]\d+)/i);
    if (jpyMatch) {
        let val = parseFloat(jpyMatch[1].replace(',', '.'));
        rates.JPY = val / 100;
    }
    
    let jpySwiftMatch = text.match(/ЯПОНИЯ[^\d]*?SWIFT[^\d]*?(\d+[.,]\d+)/i);
    if (jpySwiftMatch) {
        let val = parseFloat(jpySwiftMatch[1].replace(',', '.'));
        rates.JPY_SWIFT = val / 100;
    }
    
    let afaMatch = text.match(/AFA[^\d]*?TRADING[^\d]*?наличные[^\d]*?(\d+[.,]\d+)/i);
    if (afaMatch) {
        let val = parseFloat(afaMatch[1].replace(',', '.'));
        rates.JPY_AFA = val / 100;
    }
    
    let qrMatch = text.match(/AFA[^\d]*?TRADING[^\d]*?QR[^\d]*?(\d+[.,]\d+)/i);
    if (qrMatch) {
        let val = parseFloat(qrMatch[1].replace(',', '.'));
        rates.JPY_QR = val / 100;
    }
    
    let krwMatch = text.match(/ЮЖНАЯ[^\d]*?КОРЕЯ[^\d]*?(\d+[.,]\d+)/i);
    if (krwMatch) {
        let val = parseFloat(krwMatch[1].replace(',', '.'));
        rates.KRW = val / 1000;
    }
    
    let aedMatch = text.match(/ОАЭ[^\d]*?(\d+[.,]\d+)/i);
    if (aedMatch) rates.AED = parseFloat(aedMatch[1].replace(',', '.'));
    
    let thbMatch = text.match(/ТАИЛАНД[^\d]*?(\d+[.,]\d+)/i);
    if (thbMatch) rates.THB = parseFloat(thbMatch[1].replace(',', '.'));
    
    // Проверяем, нашли ли хоть что-то
    if (Object.keys(rates).length === 0) {
        console.log('⚠️ Не найдено ни одного курса на этой картинке');
        return null;
    }
    
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
            timeout: 10000
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
        console.error('❌ Ошибка:', error.message);
        return null;
    }
}

// --- Основная функция ---
async function fetchAllRates() {
    console.log('🔄 Загрузка свежих курсов из Telegram...');
    
    try {
        // 1. Загружаем страницу
        const response = await fetch('https://t.me/s/LoyaltySwift', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        // 2. Находим все картинки с их порядком (по дате)
        const imageData = [];
        const regex = /background-image:url\('([^']+\.jpg)'\)[^}]*?padding-top:([\d.]+)%/g;
        let match;
        let index = 0;
        while ((match = regex.exec(html)) !== null) {
            imageData.push({ 
                url: match[1], 
                ratio: parseFloat(match[2]),
                order: index++ // Порядок = свежесть
            });
        }
        
        console.log(`🖼️ Найдено ${imageData.length} изображений`);
        
        if (imageData.length === 0) {
            throw new Error('Не найдено изображений');
        }
        
        // 3. Сортируем: сначала свежие (меньший order), потом по размеру
        imageData.sort((a, b) => a.order - b.order);
        
        // 4. Пробуем картинки по порядку, пока не найдём курсы
        let finalRates = null;
        
        for (let i = 0; i < Math.min(imageData.length, 10); i++) {
            const img = imageData[i];
            console.log(`\n📸 Проверяем картинку #${i+1} (порядок: ${img.order})`);
            
            const text = await downloadAndRecognizeImage(img.url);
            if (text) {
                const rates = extractRatesFromText(text);
                if (rates) {
                    console.log('✅ Найдена картинка с курсами!');
                    finalRates = rates;
                    break;
                }
            }
        }
        
        // 5. Если не нашли курсы — используем резерв
        if (!finalRates) {
            console.log('⚠️ Не найдена картинка с курсами, используем резервные значения');
            finalRates = {};
        }
        
        // 6. Резервные значения (актуальные на сегодня)
        const fallback = {
            USD: 87.60,
            USD_IDUBID: 89.00,
            CNY: 13.10,
            JPY: 0.555,
            JPY_SWIFT: 0.555,
            JPY_AFA: 0.561,
            JPY_QR: 0.555,
            KRW: 0.0637,
            AED: 23.50,
            THB: 2.69
        };
        
        for (const key of Object.keys(fallback)) {
            if (!finalRates[key] || finalRates[key] === undefined || isNaN(finalRates[key]) || finalRates[key] === 0) {
                finalRates[key] = fallback[key];
                console.log(`⚠️ ${key} не найден, используем резерв: ${fallback[key]}`);
            }
        }
        
        console.log('\n✅ Итоговые курсы:', finalRates);
        return finalRates;
        
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
        const rates = await fetchAllRates();
        cachedRates = rates;
        lastFetch = now;
        res.json({ rates, source: 'fresh' });
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        if (cachedRates) {
            res.json({ rates: cachedRates, source: 'stale' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 Сервер с OCR работает!</h1>
        <p>Автоматически находит самую свежую картинку с курсами</p>
        <p><a href="/api/rates">/api/rates</a> - получить курсы</p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log('📸 Автоматический поиск свежих картинок с курсами');
});
