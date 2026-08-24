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
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// --- Функция для извлечения курсов из распознанного текста ---
function extractRatesFromText(text) {
    console.log('📄 Распознанный текст:', text);
    
    const rates = {};
    
    // Ищем курсы по ключевым словам
    const patterns = {
        USD: /USD[^\d]*?(\d+[.,]\d+)/i,
        USD_IDUBID: /IDUBID[^\d]*?(\d+[.,]\d+)/i,
        CNY: /КИТАЙ[^\d]*?(\d+[.,]\d+)/i,
        JPY: /ЯПОНИЯ[^\d]*?(\d+[.,]\d+)/i,
        JPY_SWIFT: /SWIFT[^\d]*?(\d+[.,]\d+)/i,
        JPY_AFA: /AFA[^\d]*?TRADING[^\d]*?(\d+[.,]\d+)/i,
        JPY_QR: /QR[^\d]*?code[^\d]*?(\d+[.,]\d+)/i,
        KRW: /КОРЕЯ[^\d]*?(\d+[.,]\d+)/i,
        AED: /АОЗ[^\d]*?(\d+[.,]\d+)/i,
        THB: /ТАИЛАНД[^\d]*?(\d+[.,]\d+)/i
    };
    
    for (const [key, pattern] of Object.entries(patterns)) {
        const match = text.match(pattern);
        if (match) {
            let val = parseFloat(match[1].replace(',', '.'));
            // Корректируем значения
            if (key === 'JPY' && val > 10) val = val / 100;
            if (key === 'JPY_SWIFT' && val > 10) val = val / 100;
            if (key === 'JPY_AFA' && val > 10) val = val / 100;
            if (key === 'JPY_QR' && val > 10) val = val / 100;
            if (key === 'KRW' && val > 10) val = val / 1000;
            rates[key] = val;
        }
    }
    
    return rates;
}

// --- Функция для скачивания и распознавания картинки ---
async function downloadAndRecognizeImage(url) {
    try {
        console.log('📥 Скачиваем картинку:', url);
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        // Сохраняем временный файл
        const tempFile = '/tmp/telegram_image.jpg';
        fs.writeFileSync(tempFile, response.data);
        console.log('✅ Картинка сохранена');
        
        // Распознаём текст через Tesseract
        console.log('🔍 Распознаём текст...');
        const result = await Tesseract.recognize(tempFile, 'rus+eng', {
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    console.log(`⏳ Распознавание: ${Math.round(m.progress * 100)}%`);
                }
            }
        });
        
        fs.unlinkSync(tempFile); // Удаляем временный файл
        return result.data.text;
        
    } catch (error) {
        console.error('❌ Ошибка при скачивании/распознавании:', error.message);
        return null;
    }
}

// --- Основная функция ---
async function fetchAllRates() {
    console.log('🔄 Загрузка курсов из Telegram через OCR...');
    
    try {
        // 1. Загружаем страницу Telegram
        const response = await fetch('https://t.me/s/LoyaltySwift', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        // 2. Находим ссылки на изображения
        const imageUrls = [];
        const regex = /background-image:url\('([^']+\.jpg)'\)/g;
        let match;
        while ((match = regex.exec(html)) !== null) {
            imageUrls.push(match[1]);
        }
        
        console.log(`🖼️ Найдено ${imageUrls.length} изображений`);
        
        if (imageUrls.length === 0) {
            throw new Error('Не найдено изображений с курсами');
        }
        
        // 3. Берём самую свежую картинку (первую в списке)
        const latestImage = imageUrls[0];
        console.log('📸 Берём самую свежую картинку');
        
        // 4. Скачиваем и распознаём
        const recognizedText = await downloadAndRecognizeImage(latestImage);
        
        if (!recognizedText) {
            throw new Error('Не удалось распознать текст');
        }
        
        // 5. Извлекаем курсы из текста
        let rates = extractRatesFromText(recognizedText);
        
        // 6. Заполняем пропуски резервными значениями
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
            if (!rates[key] || rates[key] === undefined || isNaN(rates[key])) {
                rates[key] = fallback[key];
                console.log(`⚠️ ${key} не найден, используем резерв: ${fallback[key]}`);
            }
        }
        
        console.log('✅ Итоговые курсы:', rates);
        return rates;
        
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
        <p>Курсы распознаются из картинок в Telegram</p>
        <p><a href="/api/rates">/api/rates</a> - получить курсы</p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log('📸 Используется OCR для распознавания картинок');
});
