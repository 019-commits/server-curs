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

// --- Функция для извлечения курсов ---
function extractRatesFromText(text) {
    console.log('📄 Распознанный текст (первые 300 символов):', text.substring(0, 300));
    
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
    
    if (Object.keys(rates).length === 0) {
        console.log('⚠️ Не найдено ни одного курса');
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
        
        console.log('🔍 Распознаём текст...');
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

// --- ГЛАВНАЯ ФУНКЦИЯ: находим САМЫЙ СВЕЖИЙ ПОСТ с курсами ---
async function fetchAllRates() {
    console.log('🔄 Поиск самого свежего поста с курсами...');
    
    try {
        // 1. Загружаем страницу
        const response = await fetch('https://t.me/s/LoyaltySwift', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        // 2. Находим ВСЕ посты с картинками и датами
        const posts = [];
        const postRegex = /<div[^>]*data-post="LoyaltySwift\/(\d+)"[^>]*>([\s\S]*?)<div class="tgme_widget_message_footer/g;
        let postMatch;
        
        while ((postMatch = postRegex.exec(html)) !== null) {
            const postId = postMatch[1];
            const content = postMatch[2];
            
            // Ищем дату в посте (формат: DD.MM)
            const dateMatch = content.match(/(\d{2}\.\d{2})/);
            // Ищем картинку
            const imgMatch = content.match(/background-image:url\('([^']+\.jpg)'\)/);
            
            if (dateMatch && imgMatch) {
                // Проверяем, что это пост с курсами (есть слово "КУРС" или "USD" или "JPY")
                const hasRates = content.includes('КУРС') || content.includes('USD') || content.includes('JPY');
                
                posts.push({
                    id: postId,
                    date: dateMatch[1],
                    url: imgMatch[1],
                    hasRates: hasRates,
                    content: content.substring(0, 200) // для лога
                });
            }
        }
        
        console.log(`📊 Найдено ${posts.length} постов с картинками`);
        
        if (posts.length === 0) {
            throw new Error('Не найдено постов с картинками');
        }
        
        // 3. Сортируем посты по ID (чем больше ID, тем свежее пост)
        posts.sort((a, b) => parseInt(b.id) - parseInt(a.id));
        
        // 4. Показываем все найденные посты
        console.log('\n📋 Найденные посты:');
        posts.forEach((p, i) => {
            console.log(`  ${i+1}. Пост #${p.id} от ${p.date} ${p.hasRates ? '✅ с курсами' : '❌ без курсов'}`);
        });
        
        // 5. Ищем САМЫЙ СВЕЖИЙ пост с курсами
        let targetPost = null;
        for (const post of posts) {
            if (post.hasRates) {
                targetPost = post;
                break;
            }
        }
        
        if (!targetPost) {
            console.log('⚠️ Не найдено постов с курсами, берём самый свежий с картинкой');
            targetPost = posts[0];
        }
        
        console.log(`\n✅ Выбран пост #${targetPost.id} от ${targetPost.date}`);
        console.log(`🖼️ URL картинки: ${targetPost.url.substring(0, 80)}...`);
        
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
        
        // 1. Находим самый свежий пост с курсами
        const post = await fetchAllRates();
        
        // 2. Распознаём текст на картинке
        const recognizedText = await downloadAndRecognizeImage(post.url);
        if (!recognizedText) {
            throw new Error('Не удалось распознать текст');
        }
        
        // 3. Извлекаем курсы
        let rates = extractRatesFromText(recognizedText);
        
        // 4. Резервные значения (из последнего известного поста)
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
        
        if (!rates) {
            console.log('⚠️ Не удалось распознать курсы, используем резерв');
            rates = {};
        }
        
        for (const key of Object.keys(fallback)) {
            if (!rates[key] || rates[key] === undefined || isNaN(rates[key]) || rates[key] === 0) {
                rates[key] = fallback[key];
                console.log(`⚠️ ${key} используем резерв: ${fallback[key]}`);
            }
        }
        
        console.log('\n✅ Итоговые курсы (пост от ' + post.date + '):', rates);
        
        cachedRates = rates;
        lastFetch = now;
        res.json({ 
            rates, 
            source: 'fresh', 
            post: post.id, 
            date: post.date 
        });
        
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
        <h1>🚀 Парсер свежих курсов</h1>
        <p>Автоматически находит самый свежий пост с курсами</p>
        <p><a href="/api/rates">/api/rates</a> - получить курсы</p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log('📅 Автоматический поиск самого свежего поста с курсами');
});
