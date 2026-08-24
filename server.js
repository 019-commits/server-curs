const express = require('express');
const cors = require('cors');
const Tesseract = require('tesseract.js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let cachedRates = null;
let lastFetch = 0;
const CACHE_TTL = 2 * 60 * 1000;

// --- Функция для извлечения курсов ---
function extractRatesFromText(text) {
    console.log('📄 Распознанный текст:');
    console.log(text);
    console.log('---');
    
    const rates = {};
    
    // 1. USD: ищем "150 = 87.20" или "USD = 87.20"
    let usdMatch = text.match(/(?:150|USD)\s*=\s*(\d+[.,]\d+)/i);
    if (usdMatch) {
        rates.USD = parseFloat(usdMatch[1].replace(',', '.'));
        console.log(`✅ USD: ${rates.USD}`);
    }
    
    // 2. JPY: ищем "100 JPY = 55.30"
    let jpyMatch = text.match(/100\s*(?:JPY|JY)\s*=\s*(\d+[.,]\d+)/i);
    if (jpyMatch) {
        let val = parseFloat(jpyMatch[1].replace(',', '.'));
        rates.JPY = val / 100;
        rates.JPY_SWIFT = val / 100;
        console.log(`✅ JPY: ${rates.JPY} (из ${val} за 100 JPY)`);
    }
    
    // 3. JPY_AFA: ищем "1JpY=6580"
    let afaMatch = text.match(/1JpY\s*=\s*(\d+)/i);
    if (afaMatch) {
        let val = parseFloat(afaMatch[1].replace(',', '.'));
        rates.JPY_AFA = val > 10 ? val / 100 : val;
        console.log(`✅ JPY_AFA: ${rates.JPY_AFA}`);
    }
    
    // 4. JPY_QR
    let qrMatch = text.match(/1JpY\s*=\s*(\d+[.,]\d+)/i);
    if (qrMatch && !afaMatch) {
        let val = parseFloat(qrMatch[1].replace(',', '.'));
        rates.JPY_QR = val > 10 ? val / 100 : val;
        console.log(`✅ JPY_QR: ${rates.JPY_QR}`);
    } else if (jpyMatch) {
        rates.JPY_QR = rates.JPY;
        console.log(`✅ JPY_QR: ${rates.JPY_QR} (из основного JPY)`);
    }
    
    // 5. KRW: ищем "1000 KRW = 63.60"
    let krwMatch = text.match(/1000\s*KRW\s*=\s*(\d+[.,]\d+)/i);
    if (krwMatch) {
        let val = parseFloat(krwMatch[1].replace(',', '.'));
        rates.KRW = val / 1000;
        console.log(`✅ KRW: ${rates.KRW}`);
    }
    
    // 6. AED: ищем "1AED = 23.50"
    let aedMatch = text.match(/1AED\s*=\s*(\d+[.,]\d+)/i);
    if (aedMatch) {
        rates.AED = parseFloat(aedMatch[1].replace(',', '.'));
        console.log(`✅ AED: ${rates.AED}`);
    }
    
    // 7. THB: ищем "1THB = 270"
    let thbMatch = text.match(/1THB\s*=\s*(\d+)/i);
    if (thbMatch) {
        let val = parseFloat(thbMatch[1].replace(',', '.'));
        rates.THB = val > 100 ? val / 100 : val;
        console.log(`✅ THB: ${rates.THB}`);
    }
    
    // 8. CNY: ищем "КИТАЙ" и число
    let cnyMatch = text.match(/КИТАЙ[^\d]*(\d+[.,]\d+)/i);
    if (cnyMatch) {
        rates.CNY = parseFloat(cnyMatch[1].replace(',', '.'));
        console.log(`✅ CNY: ${rates.CNY}`);
    }
    
    // 9. USD_IDUBID
    let idubidMatch = text.match(/IDUBID[^\d]*(\d+[.,]\d+)/i);
    if (idubidMatch) {
        rates.USD_IDUBID = parseFloat(idubidMatch[1].replace(',', '.'));
        console.log(`✅ USD_IDUBID: ${rates.USD_IDUBID}`);
    } else if (rates.USD) {
        rates.USD_IDUBID = rates.USD + 1.5;
        console.log(`✅ USD_IDUBID: ${rates.USD_IDUBID} (USD + 1.5)`);
    }
    
    console.log(`📊 Найдено курсов: ${Object.keys(rates).length}`);
    return rates;
}

// --- Функция для распознавания картинки через Buffer ---
async function recognizeImageFromUrl(url) {
    try {
        console.log('📥 Скачиваем картинку...');
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });

        console.log('✅ Картинка скачана, размер:', response.data.length, 'байт');
        console.log('🔍 Распознаём текст через OCR...');

        // Передаём Buffer напрямую в Tesseract (без сохранения в файл)
        const result = await Tesseract.recognize(
            Buffer.from(response.data),
            'rus+eng',
            {
                logger: (m) => {
                    if (m.status === 'recognizing text' && m.progress) {
                        console.log(`⏳ Распознавание: ${Math.round(m.progress * 100)}%`);
                    }
                }
            }
        );

        return result.data.text;

    } catch (error) {
        console.error('❌ Ошибка при распознавании:', error.message);
        return null;
    }
}

// --- ГЛАВНАЯ ФУНКЦИЯ ---
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
        const recognizedText = await recognizeImageFromUrl(post.url);
        
        if (!recognizedText) {
            return res.status(500).json({ 
                error: 'Не удалось распознать текст с картинки'
            });
        }
        
        const rates = extractRatesFromText(recognizedText);
        
        if (!rates || Object.keys(rates).length === 0) {
            return res.status(500).json({ 
                error: 'Не найдено курсов на картинке',
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
        <p><a href="/api/rates">/api/rates</a> - получить курсы</p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log('📸 Распознавание через Buffer (без файлов)');
});
