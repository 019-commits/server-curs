const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let cachedRates = null;
let lastFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

async function fetchAllRates() {
    console.log('🔄 Загрузка курсов из Telegram...');
    
    try {
        const response = await fetch('https://t.me/s/LoyaltySwift', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ошибка: ${response.status} ${response.statusText}`);
        }
        
        const html = await response.text();

        // Парсим курсы через регулярные выражения
        const rates = {};

        // --- JPY ---
        const jpyMatch = html.match(/ЯПОНИЯ[^\d]*(\d+[.,]\d+)/i);
        if (jpyMatch) {
            const val = parseFloat(jpyMatch[1].replace(',', '.'));
            rates.JPY = val / 100;
        }

        const afaMatch = html.match(/AFA\s*TRADING[^\d]*(\d+[.,]\d+)/i);
        if (afaMatch) {
            const val = parseFloat(afaMatch[1].replace(',', '.'));
            rates.JPY_AFA = val / 100;
        }

        const qrMatch = html.match(/QR[-\s]?code[^\d]*(\d+[.,]\d+)/i);
        if (qrMatch) {
            const val = parseFloat(qrMatch[1].replace(',', '.'));
            rates.JPY_QR = val / 100;
        }

        // --- USD ---
        const usdMatch = html.match(/SWIFT[^\d]*(\d+[.,]\d+)/i);
        if (usdMatch) {
            rates.USD = parseFloat(usdMatch[1].replace(',', '.'));
        }

        const idubidMatch = html.match(/IDUBID[^\d]*(\d+[.,]\d+)/i);
        if (idubidMatch) {
            rates.USD_IDUBID = parseFloat(idubidMatch[1].replace(',', '.'));
        }

        // --- CNY ---
        const cnyMatch = html.match(/КИТАЙ[^\d]*(\d+[.,]\d+)/i);
        if (cnyMatch) {
            rates.CNY = parseFloat(cnyMatch[1].replace(',', '.'));
        }

        // --- KRW ---
        const krwMatch = html.match(/(?:1000\s*KRW|ЮЖНАЯ\s*КОРЕЯ)[^\d]*(\d+[.,]\d+)/i);
        if (krwMatch) {
            const val = parseFloat(krwMatch[1].replace(',', '.'));
            rates.KRW = val / 1000;
        }

        // --- AED ---
        const aedMatch = html.match(/АОЗ[^\d]*(\d+[.,]\d+)/i);
        if (aedMatch) {
            rates.AED = parseFloat(aedMatch[1].replace(',', '.'));
        }

        // --- THB ---
        const thbMatch = html.match(/ТАИЛАНД[^\d]*(\d+[.,]\d+)/i);
        if (thbMatch) {
            rates.THB = parseFloat(thbMatch[1].replace(',', '.'));
        }

        // Резервные значения (если что-то не найдётся)
        const fallback = {
            JPY: 0.5540,
            JPY_AFA: 0.5600,
            JPY_QR: 0.5540,
            USD: 87.80,
            USD_IDUBID: 89.30,
            CNY: 13.30,
            KRW: 0.0622,
            AED: 22.90,
            THB: 2.69
        };

        for (const key of Object.keys(fallback)) {
            if (rates[key] === undefined || rates[key] === null) {
                rates[key] = fallback[key];
            }
        }

        console.log('✅ Курсы получены:', rates);
        return rates;

    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        throw error;
    }
}

app.get('/api/rates', async (req, res) => {
    try {
        const now = Date.now();
        if (cachedRates && (now - lastFetch) < CACHE_TTL) {
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

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📊 Проверка: http://localhost:${PORT}/api/rates`);
});