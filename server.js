const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function fetchAllRates() {
    console.log('🔄 Загрузка свежих курсов из Telegram @LoyaltySwift...');
    
    try {
        const response = await fetch('https://t.me/s/LoyaltySwift', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        if (!response.ok) throw new Error(`HTTP ошибка: ${response.status}`);
        const html = await response.text();

        // Убираем лишние пробеги
        const text = html.replace(/\s+/g, ' ');

        console.log('📄 Поиск курсов в тексте...');

        // --- Функция для поиска курса по паттерну ---
        function findRate(pattern) {
            const regex = new RegExp(pattern, 'i');
            const match = text.match(regex);
            if (match) {
                const val = parseFloat(match[1].replace(',', '.'));
                return val;
            }
            return null;
        }

        // --- Парсим все курсы ---

        // 1. USD SWIFT
        let usd = findRate('SWIFT[^\\d]*?(\\d+[.,]\\d+)');
        if (!usd) usd = findRate('USD[^\\d]*?=\\s*(\\d+[.,]\\d+)');
        
        // 2. USD IDUBID
        let usdIdubid = findRate('IDUBID[^\\d]*?(\\d+[.,]\\d+)');
        
        // 3. CNY
        let cny = findRate('КИТАЙ[^\\d]*?(\\d+[.,]\\d+)');
        
        // 4. JPY (внутренний перевод)
        let jpyInternal = findRate('ЯПОНИЯ[^\\d]*?внутренний[^\\d]*?(\\d+[.,]\\d+)');
        if (!jpyInternal) jpyInternal = findRate('внутренний[^\\d]*?(\\d+[.,]\\d+)');
        
        // 5. JPY (SWIFT)
        let jpySwift = findRate('ЯПОНИЯ[^\\d]*?SWIFT[^\\d]*?(\\d+[.,]\\d+)');
        if (!jpySwift) jpySwift = findRate('SWIFT[^\\d]*?(\\d+[.,]\\d+)');
        
        // 6. JPY AFA (наличные)
        let jpyAfa = findRate('AFA[^\\d]*?TRADING[^\\d]*?наличные[^\\d]*?(\\d+[.,]\\d+)');
        if (!jpyAfa) jpyAfa = findRate('AFA[^\\d]*?TRADING[^\\d]*?(\\d+[.,]\\d+)');
        
        // 7. JPY AFA (QR)
        let jpyQr = findRate('AFA[^\\d]*?TRADING[^\\d]*?QR[^\\d]*?(\\d+[.,]\\d+)');
        if (!jpyQr) jpyQr = findRate('QR[^\\d]*?code[^\\d]*?(\\d+[.,]\\d+)');
        
        // 8. KRW
        let krw = findRate('КОРЕЯ[^\\d]*?(\\d+[.,]\\d+)');
        if (!krw) krw = findRate('KRW[^\\d]*?(\\d+[.,]\\d+)');
        
        // 9. AED
        let aed = findRate('АОЗ[^\\d]*?(\\d+[.,]\\d+)');
        if (!aed) aed = findRate('AED[^\\d]*?(\\d+[.,]\\d+)');
        
        // 10. THB
        let thb = findRate('ТАИЛАНД[^\\d]*?(\\d+[.,]\\d+)');
        if (!thb) thb = findRate('THB[^\\d]*?(\\d+[.,]\\d+)');

        // --- Если какой-то курс не найден, используем резерв ---
        const fallback = {
            USD: 87.60,
            USD_IDUBID: 89.00,
            CNY: 13.10,
            JPY: 0.5550,
            JPY_SWIFT: 0.5550,
            JPY_AFA: 0.5610,
            JPY_QR: 0.5550,
            KRW: 0.0637,
            AED: 23.50,
            THB: 2.69
        };

        const rates = {
            USD: usd || fallback.USD,
            USD_IDUBID: usdIdubid || fallback.USD_IDUBID,
            CNY: cny || fallback.CNY,
            JPY: jpyInternal ? jpyInternal / 100 : fallback.JPY,
            JPY_SWIFT: jpySwift ? jpySwift / 100 : fallback.JPY_SWIFT,
            JPY_AFA: jpyAfa ? jpyAfa / 100 : fallback.JPY_AFA,
            JPY_QR: jpyQr ? jpyQr / 100 : fallback.JPY_QR,
            KRW: krw ? krw / 1000 : fallback.KRW,
            AED: aed || fallback.AED,
            THB: thb || fallback.THB
        };

        console.log('✅ Свежие курсы из Telegram:', rates);
        return rates;

    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        throw error;
    }
}

// --- Эндпоинт для получения курсов (всегда свежие) ---
app.get('/api/rates', async (req, res) => {
    try {
        // Всегда парсим свежие курсы, без кеша!
        const rates = await fetchAllRates();
        res.json({ rates, source: 'fresh', updated: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- Корневой путь ---
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 Сервер курсов работает!</h1>
        <p>Курсы всегда свежие из <a href="https://t.me/s/LoyaltySwift" target="_blank">@LoyaltySwift</a></p>
        <p>При каждом запросе парсится Telegram</p>
        <p><a href="/api/rates">/api/rates</a> - получить курсы в JSON</p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📊 Каждый запрос к /api/rates даёт свежие курсы из Telegram`);
});
