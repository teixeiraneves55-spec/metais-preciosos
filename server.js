require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const exchangeRates = { EUR: 1, USD: 1.08, FCFA: 655.96 };

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'user', created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS materials (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, subtype TEXT, stock_grams DECIMAL(10,3) DEFAULT 0, stock_carats DECIMAL(10,3) DEFAULT 0, unit TEXT DEFAULT 'g', market_price_eur DECIMAL(10,2) DEFAULT 0)`);
    await client.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, lot_number TEXT, material_id INTEGER REFERENCES materials(id), type TEXT NOT NULL, weight_grams DECIMAL(10,3), weight_carats DECIMAL(10,3), price_per_unit DECIMAL(10,2), total_price DECIMAL(12,2), currency TEXT DEFAULT 'EUR', total_price_eur DECIMAL(12,2), quality TEXT, origin TEXT, client_name TEXT, payment_method TEXT, notes TEXT, transaction_date DATE, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, address TEXT, nif TEXT, total_purchases DECIMAL(12,2) DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS treasury (id SERIAL PRIMARY KEY, date DATE NOT NULL, description TEXT, type TEXT NOT NULL, amount DECIMAL(12,2) NOT NULL, currency TEXT DEFAULT 'EUR', amount_eur DECIMAL(12,2), category TEXT, reference TEXT, created_at TIMESTAMP DEFAULT NOW())`);

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@metaispreciosos.pt';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
    const existingAdmin = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (existingAdmin.rows.length === 0) {
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await client.query('INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)', ['Administrador', adminEmail, hashedPassword, 'admin']);
    }
    console.log('DB ok');
  } finally { client.release(); }
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'segredo123', { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) { res.status(500).json({ error: 'Erro no servidor' }); }
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'segredo123');
    req.user = decoded;
    next();
  } catch (error) { res.status(401).json({ error: 'Token inválido' }); }
}

app.get('/api/exchange-rates', authMiddleware, (req, res) => { res.json(exchangeRates); });

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const sr = await pool.query('SELECT COUNT(*) as total FROM materials');
    const ms = new Date(); ms.setDate(1); ms.setHours(0,0,0,0);
    const mr = await pool.query("SELECT type, SUM(total_price_eur) as total FROM transactions WHERE transaction_date >= $1 GROUP BY type", [ms.toISOString().split('T')[0]]);
    const rr = await pool.query("SELECT t.*, m.name as material_name FROM transactions t JOIN materials m ON t.material_id = m.id ORDER BY t.created_at DESC LIMIT 10");
    const tr = await pool.query("SELECT type, SUM(amount_eur) as total FROM treasury WHERE date >= $1 GROUP BY type", [ms.toISOString().split('T')[0]]);
    res.json({
      totalItems: sr.rows[0].total,
      monthPurchases: mr.rows.find(r => r.type === 'purchase')?.total || 0,
      monthSales: mr.rows.find(r => r.type === 'sale')?.total || 0,
      treasuryBalance: (tr.rows.find(r => r.type === 'income')?.total || 0) - (tr.rows.find(r => r.type === 'expense')?.total || 0),
      recentTransactions: rr.rows
    });
  } catch (error) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/materials', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM materials ORDER BY name'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/materials', authMiddleware, async (req, res) => {
  try {
    const { code, name, type, subtype, unit, market_price_eur } = req.body;
    const r = await pool.query('INSERT INTO materials (code, name, type, subtype, unit, market_price_eur) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [code, name, type, subtype, unit, market_price_eur || 0]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.put('/api/materials/:id/price', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE materials SET market_price_eur = $1 WHERE id = $2', [req.body.market_price_eur, req.params.id]);
    res.json({ message: 'OK' });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/materials/seed', authMiddleware, async (req, res) => {
  try {
    const mats = [
      { code: 'AU24K', name: 'Ouro 24K', type: 'metal', subtype: 'Ouro', unit: 'g', price: 72 },
      { code: 'AU22K', name: 'Ouro 22K', type: 'metal', subtype: 'Ouro', unit: 'g', price: 66 },
      { code: 'AU20K', name: 'Ouro 20K', type: 'metal', subtype: 'Ouro', unit: 'g', price: 60 },
      { code: 'AU18K', name: 'Ouro 18K', type: 'metal', subtype: 'Ouro', unit: 'g', price: 54 },
      { code: 'SAF01', name: 'Safira Azul', type: 'gem', subtype: 'Safira', unit: 'ct', price: 500 },
      { code: 'SAF02', name: 'Safira Rosa', type: 'gem', subtype: 'Safira', unit: 'ct', price: 600 },
      { code: 'DIA01', name: 'Diamante 1ct', type: 'gem', subtype: 'Diamante', unit: 'ct', price: 5000 },
      { code: 'DIA02', name: 'Diamante 0.5ct', type: 'gem', subtype: 'Diamante', unit: 'ct', price: 2000 }
    ];
    for (const m of mats) {
      await pool.query('INSERT INTO materials (code, name, type, subtype, unit, market_price_eur) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO UPDATE SET market_price_eur = $6', [m.code, m.name, m.type, m.subtype, m.unit, m.price]);
    }
    res.json({ message: 'OK' });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query("SELECT t.*, m.name as material_name FROM transactions t JOIN materials m ON t.material_id = m.id ORDER BY t.transaction_date DESC, t.created_at DESC");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/transactions/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/transactions', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { material_id, type, weight_grams, weight_carats, price_per_unit, total_price, currency, quality, origin, client_name, payment_method, notes, transaction_date, lot_number } = req.body;
    const total_price_eur = total_price / (exchangeRates[currency] || 1);
    const prefix = type === 'purchase' ? 'COMPRA' : 'VENDA';
    const dateStr = transaction_date.replace(/-/g, '');
    const cr = await client.query('SELECT COUNT(*) FROM transactions WHERE transaction_date = $1', [transaction_date]);
    const code = prefix + '-' + dateStr + '-' + (parseInt(cr.rows[0].count) + 1).toString().padStart(4, '0');
    const lot = lot_number || 'LOTE-' + dateStr + '-' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

    await client.query('BEGIN');
    await client.query(`INSERT INTO transactions (code, lot_number, material_id, type, weight_grams, weight_carats, price_per_unit, total_price, currency, total_price_eur, quality, origin, client_name, payment_method, notes, transaction_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [code, lot, material_id, type, weight_grams || 0, weight_carats || 0, price_per_unit, total_price, currency, total_price_eur, quality, origin, client_name, payment_method, notes, transaction_date]);

    if (type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [weight_grams || 0, weight_carats || 0, material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [weight_grams || 0, weight_carats || 0, material_id]);
    }

    const tt = type === 'purchase' ? 'expense' : 'income';
    await client.query('INSERT INTO treasury (date, description, type, amount, currency, amount_eur, category, reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [transaction_date, 'Transação ' + code, tt, total_price, currency, total_price_eur, 'Materiais', code]);
    await client.query('COMMIT');
    res.status(201).json({ message: 'OK', code, lot });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro transação:', error);
    res.status(500).json({ error: 'Erro ao registar' });
  } finally { client.release(); }
});

app.put('/api/transactions/:id', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { material_id, type, weight_grams, weight_carats, price_per_unit, total_price, currency, quality, origin, client_name, payment_method, notes, transaction_date, lot_number } = req.body;
    const total_price_eur = total_price / (exchangeRates[currency] || 1);
    const old = await client.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (old.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    const o = old.rows[0];
    if (o.type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [o.weight_grams || 0, o.weight_carats || 0, o.material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [o.weight_grams || 0, o.weight_carats || 0, o.material_id]);
    }
    await client.query('DELETE FROM treasury WHERE reference = $1', [o.code]);
    await client.query('BEGIN');
    await client.query(`UPDATE transactions SET material_id=$1, type=$2, weight_grams=$3, weight_carats=$4, price_per_unit=$5, total_price=$6, currency=$7, total_price_eur=$8, quality=$9, origin=$10, client_name=$11, payment_method=$12, notes=$13, transaction_date=$14, lot_number=$15, updated_at=NOW() WHERE id=$16`, [material_id, type, weight_grams || 0, weight_carats || 0, price_per_unit, total_price, currency, total_price_eur, quality, origin, client_name, payment_method, notes, transaction_date, lot_number, req.params.id]);
    if (type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [weight_grams || 0, weight_carats || 0, material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [weight_grams || 0, weight_carats || 0, material_id]);
    }
    const tt = type === 'purchase' ? 'expense' : 'income';
    await client.query('INSERT INTO treasury (date, description, type, amount, currency, amount_eur, category, reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [transaction_date, 'Transação ' + o.code + ' (edit)', tt, total_price, currency, total_price_eur, 'Materiais', o.code]);
    await client.query('COMMIT');
    res.json({ message: 'OK' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro update:', error);
    res.status(500).json({ error: 'Erro' });
  } finally { client.release(); }
});

app.delete('/api/transactions/:id', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const old = await client.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (old.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    const o = old.rows[0];
    await client.query('BEGIN');
    if (o.type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [o.weight_grams || 0, o.weight_carats || 0, o.material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [o.weight_grams || 0, o.weight_carats || 0, o.material_id]);
    }
    await client.query('DELETE FROM treasury WHERE reference = $1', [o.code]);
    await client.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'OK' });
  } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Erro' }); }
  finally { client.release(); }
});

app.get('/api/treasury', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM treasury ORDER BY date DESC LIMIT 100');
    const s = await pool.query('SELECT type, SUM(amount_eur) as total FROM treasury GROUP BY type');
    res.json({ transactions: r.rows, income: s.rows.find(r => r.type === 'income')?.total || 0, expense: s.rows.find(r => r.type === 'expense')?.total || 0, balance: (s.rows.find(r => r.type === 'income')?.total || 0) - (s.rows.find(r => r.type === 'expense')?.total || 0) });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/clients', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM clients ORDER BY name'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { name, email, phone, address, nif } = req.body;
    const r = await pool.query('INSERT INTO clients (name, email, phone, address, nif) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, email, phone, address, nif]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/stock-value', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM materials ORDER BY name');
    const materials = r.rows.map(m => {
      const tw = parseFloat(m.stock_grams || 0) + parseFloat(m.stock_carats || 0) * 0.2;
      const mv = tw * parseFloat(m.market_price_eur || 0);
      return { ...m, totalWeight: tw, marketValue: mv.toFixed(2), estimatedValue: (mv * 0.8).toFixed(2) };
    });
    res.json(materials);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

initDB().then(() => { app.listen(PORT, () => console.log('Servidor na porta ' + PORT)); });
