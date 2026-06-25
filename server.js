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
    // Recriar tabelas com estrutura correta
    await client.query(`DROP TABLE IF EXISTS treasury CASCADE`);
    await client.query(`DROP TABLE IF EXISTS transactions CASCADE`);
    await client.query(`DROP TABLE IF EXISTS materials CASCADE`);
    await client.query(`DROP TABLE IF EXISTS clients CASCADE`);
    await client.query(`DROP TABLE IF EXISTS users CASCADE`);

    await client.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'user', created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE materials (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, subtype TEXT, stock_grams DECIMAL(10,3) DEFAULT 0, stock_carats DECIMAL(10,3) DEFAULT 0, unit TEXT DEFAULT 'g', market_price_eur DECIMAL(10,2) DEFAULT 0)`);
    await client.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, address TEXT, nif TEXT, total_purchases DECIMAL(12,2) DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE transactions (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, lot_number TEXT, material_id INTEGER REFERENCES materials(id), type TEXT NOT NULL, weight_grams DECIMAL(10,3) DEFAULT 0, weight_carats DECIMAL(10,3) DEFAULT 0, price_per_unit DECIMAL(10,2) NOT NULL, total_price DECIMAL(12,2) NOT NULL, currency TEXT DEFAULT 'EUR', total_price_eur DECIMAL(12,2) DEFAULT 0, quality TEXT, origin TEXT, client_name TEXT, payment_method TEXT DEFAULT 'cash', notes TEXT, transaction_date DATE NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE treasury (id SERIAL PRIMARY KEY, date DATE NOT NULL, description TEXT, type TEXT NOT NULL, amount DECIMAL(12,2) NOT NULL, currency TEXT DEFAULT 'EUR', amount_eur DECIMAL(12,2) DEFAULT 0, category TEXT DEFAULT 'Materiais', reference TEXT, created_at TIMESTAMP DEFAULT NOW())`);

    // Admin
    const hashedPassword = await bcrypt.hash('Admin123!', 10);
    await client.query('INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING', ['Administrador', 'admin@metaispreciosos.pt', hashedPassword, 'admin']);

    // Materiais padrão
    const mats = [
      ['AU24K','Ouro 24K','metal','Ouro','g',72],
      ['AU22K','Ouro 22K','metal','Ouro','g',66],
      ['AU20K','Ouro 20K','metal','Ouro','g',60],
      ['AU18K','Ouro 18K','metal','Ouro','g',54],
      ['SAF01','Safira Azul','gem','Safira','ct',500],
      ['SAF02','Safira Rosa','gem','Safira','ct',600],
      ['DIA01','Diamante 1ct','gem','Diamante','ct',5000],
      ['DIA02','Diamante 0.5ct','gem','Diamante','ct',2000]
    ];
    for (const m of mats) {
      await client.query('INSERT INTO materials (code, name, type, subtype, unit, market_price_eur) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO UPDATE SET market_price_eur = $6', m);
    }

    console.log('DB recriada com sucesso');
  } catch(e) {
    console.error('Erro DB:', e);
  } finally { client.release(); }
}

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'segredo123', { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: 'Erro no servidor' }); }
});

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'segredo123');
    next();
  } catch (e) { res.status(401).json({ error: 'Token inválido' }); }
}

app.get('/api/exchange-rates', auth, (req, res) => res.json(exchangeRates));

// DASHBOARD
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const sr = await pool.query('SELECT COUNT(*) as c FROM materials');
    const ms = new Date(); ms.setDate(1); ms.setHours(0,0,0,0);
    const md = ms.toISOString().split('T')[0];
    const mr = await pool.query("SELECT type, COALESCE(SUM(total_price_eur),0) as t FROM transactions WHERE transaction_date >= $1 GROUP BY type", [md]);
    const rr = await pool.query("SELECT t.*, m.name as mn FROM transactions t JOIN materials m ON t.material_id = m.id ORDER BY t.created_at DESC LIMIT 10");
    const tr = await pool.query("SELECT type, COALESCE(SUM(amount_eur),0) as t FROM treasury WHERE date >= $1 GROUP BY type", [md]);
    const inc = parseFloat(tr.rows.find(r => r.type === 'income')?.t || 0);
    const exp = parseFloat(tr.rows.find(r => r.type === 'expense')?.t || 0);
    res.json({
      totalItems: parseInt(sr.rows[0].c),
      monthPurchases: parseFloat(mr.rows.find(r => r.type === 'purchase')?.t || 0),
      monthSales: parseFloat(mr.rows.find(r => r.type === 'sale')?.t || 0),
      treasuryBalance: inc - exp,
      recentTransactions: rr.rows
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro' }); }
});

// MATERIAIS
app.get('/api/materials', auth, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM materials ORDER BY name'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/materials', auth, async (req, res) => {
  try {
    const { code, name, type, subtype, unit, market_price_eur } = req.body;
    const r = await pool.query('INSERT INTO materials (code, name, type, subtype, unit, market_price_eur) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [code, name, type, subtype, unit, parseFloat(market_price_eur) || 0]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.put('/api/materials/:id/price', auth, async (req, res) => {
  try {
    await pool.query('UPDATE materials SET market_price_eur = $1 WHERE id = $2', [parseFloat(req.body.market_price_eur), req.params.id]);
    res.json({ message: 'OK' });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});
// Atualizar preço por código
app.put('/api/materials/update-by-code', auth, async (req, res) => {
  try {
    const { code, price } = req.body;
    await pool.query('UPDATE materials SET market_price_eur = $1 WHERE code = $2', [parseFloat(price), code]);
    res.json({ message: 'OK' });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// STOCK VALUE
app.get('/api/stock-value', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM materials ORDER BY name');
    const mats = r.rows.map(m => {
      const tw = parseFloat(m.stock_grams || 0) + parseFloat(m.stock_carats || 0) * 0.2;
      const mv = tw * parseFloat(m.market_price_eur || 0);
      return { ...m, estimatedValue: (mv * 0.8).toFixed(2), marketPrice: parseFloat(m.market_price_eur).toFixed(2) };
    });
    res.json(mats);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// TRANSAÇÕES
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT t.*, m.name as mn FROM transactions t JOIN materials m ON t.material_id = m.id ORDER BY t.transaction_date DESC, t.created_at DESC LIMIT 200");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/transactions/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/transactions', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body;
    const totalPriceEur = parseFloat(b.total_price) / (exchangeRates[b.currency] || 1);
    const prefix = b.type === 'purchase' ? 'COMPRA' : 'VENDA';
    const ds = b.transaction_date.replace(/-/g, '');
    const cr = await client.query('SELECT COUNT(*) as c FROM transactions WHERE transaction_date = $1', [b.transaction_date]);
    const code = prefix + '-' + ds + '-' + (parseInt(cr.rows[0].c) + 1).toString().padStart(4, '0');
    const lot = b.lot_number || 'LOTE-' + ds + '-' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

    await client.query('BEGIN');

    await client.query(
      'INSERT INTO transactions (code, lot_number, material_id, type, weight_grams, weight_carats, price_per_unit, total_price, currency, total_price_eur, quality, origin, client_name, payment_method, notes, transaction_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [code, lot, b.material_id, b.type, parseFloat(b.weight_grams) || 0, parseFloat(b.weight_carats) || 0, parseFloat(b.price_per_unit), parseFloat(b.total_price), b.currency, totalPriceEur, b.quality || '', b.origin || '', b.client_name || '', b.payment_method || 'cash', b.notes || '', b.transaction_date]
    );

    // Atualizar stock
    if (b.type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [parseFloat(b.weight_grams) || 0, parseFloat(b.weight_carats) || 0, b.material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [parseFloat(b.weight_grams) || 0, parseFloat(b.weight_carats) || 0, b.material_id]);
    }

    // Tesouraria
    const tt = b.type === 'purchase' ? 'expense' : 'income';
    await client.query('INSERT INTO treasury (date, description, type, amount, currency, amount_eur, reference) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [b.transaction_date, 'Transação ' + code, tt, parseFloat(b.total_price), b.currency, totalPriceEur, code]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'OK', code, lot });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro transação:', e.message);
    res.status(500).json({ error: 'Erro ao registar: ' + e.message });
  } finally { client.release(); }
});

// EDITAR TRANSAÇÃO
app.put('/api/transactions/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body;
    const old = await client.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (old.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    const o = old.rows[0];

    // Reverter stock antigo
    if (o.type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [parseFloat(o.weight_grams) || 0, parseFloat(o.weight_carats) || 0, o.material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [parseFloat(o.weight_grams) || 0, parseFloat(o.weight_carats) || 0, o.material_id]);
    }
    await client.query('DELETE FROM treasury WHERE reference = $1', [o.code]);

    const totalPriceEur = parseFloat(b.total_price) / (exchangeRates[b.currency] || 1);

    await client.query('BEGIN');

    await client.query(
      'UPDATE transactions SET material_id=$1, type=$2, weight_grams=$3, weight_carats=$4, price_per_unit=$5, total_price=$6, currency=$7, total_price_eur=$8, quality=$9, origin=$10, client_name=$11, payment_method=$12, notes=$13, transaction_date=$14, lot_number=$15, updated_at=NOW() WHERE id=$16',
      [b.material_id, b.type, parseFloat(b.weight_grams) || 0, parseFloat(b.weight_carats) || 0, parseFloat(b.price_per_unit), parseFloat(b.total_price), b.currency, totalPriceEur, b.quality || '', b.origin || '', b.client_name || '', b.payment_method || 'cash', b.notes || '', b.transaction_date, b.lot_number, req.params.id]
    );

    // Novo stock
    if (b.type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [parseFloat(b.weight_grams) || 0, parseFloat(b.weight_carats) || 0, b.material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [parseFloat(b.weight_grams) || 0, parseFloat(b.weight_carats) || 0, b.material_id]);
    }

    const tt = b.type === 'purchase' ? 'expense' : 'income';
    await client.query('INSERT INTO treasury (date, description, type, amount, currency, amount_eur, reference) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [b.transaction_date, 'Transação ' + o.code + ' (edit)', tt, parseFloat(b.total_price), b.currency, totalPriceEur, o.code]);

    await client.query('COMMIT');
    res.json({ message: 'OK' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro update:', e.message);
    res.status(500).json({ error: 'Erro: ' + e.message });
  } finally { client.release(); }
});

// APAGAR TRANSAÇÃO
app.delete('/api/transactions/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const old = await client.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (old.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    const o = old.rows[0];

    await client.query('BEGIN');
    if (o.type === 'purchase') {
      await client.query('UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3', [parseFloat(o.weight_grams) || 0, parseFloat(o.weight_carats) || 0, o.material_id]);
    } else {
      await client.query('UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3', [parseFloat(o.weight_grams) || 0, parseFloat(o.weight_carats) || 0, o.material_id]);
    }
    await client.query('DELETE FROM treasury WHERE reference = $1', [o.code]);
    await client.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'OK' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro' });
  } finally { client.release(); }
});

// TESOURARIA
app.get('/api/treasury', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM treasury ORDER BY date DESC, created_at DESC LIMIT 200');
    const s = await pool.query('SELECT type, COALESCE(SUM(amount_eur),0) as t FROM treasury GROUP BY type');
    const inc = parseFloat(s.rows.find(r => r.type === 'income')?.t || 0);
    const exp = parseFloat(s.rows.find(r => r.type === 'expense')?.t || 0);
    res.json({ transactions: r.rows, income: inc, expense: exp, balance: inc - exp });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// CLIENTES
app.get('/api/clients', auth, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM clients ORDER BY name'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    const { name, email, phone, address, nif } = req.body;
    const r = await pool.query('INSERT INTO clients (name, email, phone, address, nif) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, email || '', phone || '', address || '', nif || '']);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => app.listen(PORT, () => console.log('Servidor na porta ' + PORT)));
