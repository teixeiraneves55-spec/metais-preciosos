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

const rates = { EUR: 1, USD: 1.08, FCFA: 655.96 };

async function init() {
  const c = await pool.connect();
  try {
    // Remover tabelas antigas
    await c.query(`DROP TABLE IF EXISTS transactions CASCADE`);
    await c.query(`DROP TABLE IF EXISTS treasury CASCADE`);
    await c.query(`DROP TABLE IF EXISTS products CASCADE`);
    await c.query(`DROP TABLE IF EXISTS clients CASCADE`);
    await c.query(`DROP TABLE IF EXISTS users CASCADE`);

    // Criar tabelas novas
    await c.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'user')`);
    await c.query(`CREATE TABLE products (id SERIAL PRIMARY KEY, code TEXT UNIQUE, name TEXT, type TEXT, subtype TEXT, stock_g DECIMAL(10,3) DEFAULT 0, stock_ct DECIMAL(10,3) DEFAULT 0, unit TEXT DEFAULT 'g', price_eur DECIMAL(10,2) DEFAULT 0)`);
    await c.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, email TEXT, phone TEXT, address TEXT, nif TEXT, total DECIMAL(12,2) DEFAULT 0)`);
    await c.query(`CREATE TABLE transactions (id SERIAL PRIMARY KEY, code TEXT UNIQUE, lot TEXT, product_id INTEGER, type TEXT, wg DECIMAL(10,3) DEFAULT 0, wct DECIMAL(10,3) DEFAULT 0, price_unit DECIMAL(10,2), total DECIMAL(12,2), currency TEXT DEFAULT 'EUR', total_eur DECIMAL(12,2), quality TEXT, origin TEXT, client TEXT, payment TEXT, notes TEXT, tdate DATE, created TIMESTAMP DEFAULT NOW())`);
    await c.query(`CREATE TABLE treasury (id SERIAL PRIMARY KEY, tdate DATE, descr TEXT, type TEXT, amount DECIMAL(12,2), currency TEXT DEFAULT 'EUR', amount_eur DECIMAL(12,2), ref TEXT)`);

    // Admin
    const pw = await bcrypt.hash('Admin123!', 10);
    await c.query('INSERT INTO users (name,email,password,role) VALUES ($1,$2,$3,$4)', ['Admin','admin@metaispreciosos.pt',pw,'admin']);

    // Produtos
    const prods = [
      ['AU24K','Ouro 24K','metal','Ouro','g',72],
      ['AU22K','Ouro 22K','metal','Ouro','g',66],
      ['AU20K','Ouro 20K','metal','Ouro','g',60],
      ['AU18K','Ouro 18K','metal','Ouro','g',54],
      ['SAF01','Safira Azul','gem','Safira','ct',500],
      ['SAF02','Safira Rosa','gem','Safira','ct',600],
      ['DIA01','Diamante 1ct','gem','Diamante','ct',5000],
      ['DIA02','Diamante 0.5ct','gem','Diamante','ct',2000]
    ];
    for (const p of prods) {
      await c.query('INSERT INTO products (code,name,type,subtype,unit,price_eur) VALUES ($1,$2,$3,$4,$5,$6)', p);
    }
    console.log('DB OK - Tabelas recriadas');
  } finally { c.release(); }
}

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
    const ok = await bcrypt.compare(password, r.rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = jwt.sign({ id: r.rows[0].id, email: r.rows[0].email, role: r.rows[0].role }, process.env.JWT_SECRET || 'x', { expiresIn: '90d' });
    res.json({ token, user: { id: r.rows[0].id, name: r.rows[0].name, email: r.rows[0].email } });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

function auth(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Não autorizado' });
  try { req.user = jwt.verify(t, process.env.JWT_SECRET || 'x'); next(); }
  catch (e) { res.status(401).json({ error: 'Token inválido' }); }
}

app.get('/api/rates', auth, (req, res) => res.json(rates));

app.get('/api/products', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM products ORDER BY name');
  res.json(r.rows);
});

app.post('/api/products', auth, async (req, res) => {
  const { code, name, type, subtype, unit, price_eur } = req.body;
  const r = await pool.query('INSERT INTO products (code,name,type,subtype,unit,price_eur) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [code, name, type, subtype, unit, parseFloat(price_eur) || 0]);
  res.status(201).json(r.rows[0]);
});

app.put('/api/products/price', auth, async (req, res) => {
  const { code, price } = req.body;
  await pool.query('UPDATE products SET price_eur=$1 WHERE code=$2', [parseFloat(price), code]);
  res.json({ ok: true });
});

app.get('/api/dashboard', auth, async (req, res) => {
  const pc = await pool.query('SELECT COUNT(*) as c FROM products');
  const ms = new Date(); ms.setDate(1); ms.setHours(0,0,0,0);
  const md = ms.toISOString().split('T')[0];
  const mr = await pool.query("SELECT type, COALESCE(SUM(total_eur),0) as t FROM transactions WHERE tdate >= $1 GROUP BY type", [md]);
  const tr = await pool.query("SELECT type, COALESCE(SUM(amount_eur),0) as t FROM treasury WHERE tdate >= $1 GROUP BY type", [md]);
  const rr = await pool.query("SELECT t.*, p.name as pname FROM transactions t JOIN products p ON t.product_id=p.id ORDER BY t.created DESC LIMIT 10");
  const inc = parseFloat(tr.rows.find(r => r.type === 'income')?.t || 0);
  const exp = parseFloat(tr.rows.find(r => r.type === 'expense')?.t || 0);
  res.json({ items: parseInt(pc.rows[0].c), purchases: parseFloat(mr.rows.find(r => r.type === 'purchase')?.t || 0), sales: parseFloat(mr.rows.find(r => r.type === 'sale')?.t || 0), balance: inc - exp, recent: rr.rows });
});

app.get('/api/transactions', auth, async (req, res) => {
  const r = await pool.query("SELECT t.*, p.name as pname, p.code as pcode FROM transactions t JOIN products p ON t.product_id=p.id ORDER BY t.tdate DESC, t.created DESC LIMIT 500");
  res.json(r.rows);
});

app.get('/api/transactions/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
  res.json(r.rows[0]);
});

app.post('/api/transactions', auth, async (req, res) => {
  const cl = await pool.connect();
  try {
    const b = req.body;
    const eur = parseFloat(b.total) / (rates[b.currency] || 1);
    const prefix = b.type === 'purchase' ? 'C' : 'V';
    const ds = b.tdate.replace(/-/g, '');
    const cr = await cl.query('SELECT COUNT(*) as c FROM transactions WHERE tdate=$1', [b.tdate]);
    const code = prefix + ds + (parseInt(cr.rows[0].c) + 1).toString().padStart(4, '0');
    const lot = b.lot || 'LT' + ds + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

    await cl.query('BEGIN');
    await cl.query(
      'INSERT INTO transactions (code,lot,product_id,type,wg,wct,price_unit,total,currency,total_eur,quality,origin,client,payment,notes,tdate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [code, lot, b.product_id, b.type, parseFloat(b.wg) || 0, parseFloat(b.wct) || 0, parseFloat(b.price_unit), parseFloat(b.total), b.currency, eur, b.quality || '', b.origin || '', b.client || '', b.payment || 'cash', b.notes || '', b.tdate]
    );

    if (b.type === 'purchase') {
      await cl.query('UPDATE products SET stock_g=stock_g+$1, stock_ct=stock_ct+$2 WHERE id=$3', [parseFloat(b.wg) || 0, parseFloat(b.wct) || 0, b.product_id]);
    } else {
      await cl.query('UPDATE products SET stock_g=stock_g-$1, stock_ct=stock_ct-$2 WHERE id=$3', [parseFloat(b.wg) || 0, parseFloat(b.wct) || 0, b.product_id]);
    }

    const tt = b.type === 'purchase' ? 'expense' : 'income';
    await cl.query('INSERT INTO treasury (tdate,descr,type,amount,currency,amount_eur,ref) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [b.tdate, code + ' - ' + (b.client || 'Geral'), tt, parseFloat(b.total), b.currency, eur, code]);

    await cl.query('COMMIT');
    res.status(201).json({ message: 'OK', code, lot });
  } catch (e) {
    await cl.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Erro: ' + e.message });
  } finally { cl.release(); }
});

app.put('/api/transactions/:id', auth, async (req, res) => {
  const cl = await pool.connect();
  try {
    const b = req.body;
    const old = await cl.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (old.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    const o = old.rows[0];

    if (o.type === 'purchase') {
      await cl.query('UPDATE products SET stock_g=stock_g-$1, stock_ct=stock_ct-$2 WHERE id=$3', [parseFloat(o.wg) || 0, parseFloat(o.wct) || 0, o.product_id]);
    } else {
      await cl.query('UPDATE products SET stock_g=stock_g+$1, stock_ct=stock_ct+$2 WHERE id=$3', [parseFloat(o.wg) || 0, parseFloat(o.wct) || 0, o.product_id]);
    }
    await cl.query('DELETE FROM treasury WHERE ref=$1', [o.code]);

    const eur = parseFloat(b.total) / (rates[b.currency] || 1);
    await cl.query('BEGIN');
    await cl.query('UPDATE transactions SET product_id=$1,type=$2,wg=$3,wct=$4,price_unit=$5,total=$6,currency=$7,total_eur=$8,quality=$9,origin=$10,client=$11,payment=$12,notes=$13,tdate=$14,lot=$15 WHERE id=$16',
      [b.product_id, b.type, parseFloat(b.wg) || 0, parseFloat(b.wct) || 0, parseFloat(b.price_unit), parseFloat(b.total), b.currency, eur, b.quality || '', b.origin || '', b.client || '', b.payment || 'cash', b.notes || '', b.tdate, b.lot, req.params.id]);

    if (b.type === 'purchase') {
      await cl.query('UPDATE products SET stock_g=stock_g+$1, stock_ct=stock_ct+$2 WHERE id=$3', [parseFloat(b.wg) || 0, parseFloat(b.wct) || 0, b.product_id]);
    } else {
      await cl.query('UPDATE products SET stock_g=stock_g-$1, stock_ct=stock_ct-$2 WHERE id=$3', [parseFloat(b.wg) || 0, parseFloat(b.wct) || 0, b.product_id]);
    }

    const tt = b.type === 'purchase' ? 'expense' : 'income';
    await cl.query('INSERT INTO treasury (tdate,descr,type,amount,currency,amount_eur,ref) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [b.tdate, o.code + ' (edit)', tt, parseFloat(b.total), b.currency, eur, o.code]);

    await cl.query('COMMIT');
    res.json({ message: 'OK' });
  } catch (e) {
    await cl.query('ROLLBACK');
    res.status(500).json({ error: 'Erro' });
  } finally { cl.release(); }
});

app.delete('/api/transactions/:id', auth, async (req, res) => {
  const cl = await pool.connect();
  try {
    const o = await cl.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (o.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
    const t = o.rows[0];
    await cl.query('BEGIN');
    if (t.type === 'purchase') {
      await cl.query('UPDATE products SET stock_g=stock_g-$1, stock_ct=stock_ct-$2 WHERE id=$3', [parseFloat(t.wg) || 0, parseFloat(t.wct) || 0, t.product_id]);
    } else {
      await cl.query('UPDATE products SET stock_g=stock_g+$1, stock_ct=stock_ct+$2 WHERE id=$3', [parseFloat(t.wg) || 0, parseFloat(t.wct) || 0, t.product_id]);
    }
    await cl.query('DELETE FROM treasury WHERE ref=$1', [t.code]);
    await cl.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
    await cl.query('COMMIT');
    res.json({ message: 'OK' });
  } catch (e) { await cl.query('ROLLBACK'); res.status(500).json({ error: 'Erro' }); }
  finally { cl.release(); }
});

app.get('/api/treasury', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM treasury ORDER BY tdate DESC, id DESC LIMIT 300');
  const s = await pool.query('SELECT type, COALESCE(SUM(amount_eur),0) as t FROM treasury GROUP BY type');
  const inc = parseFloat(s.rows.find(r => r.type === 'income')?.t || 0);
  const exp = parseFloat(s.rows.find(r => r.type === 'expense')?.t || 0);
  res.json({ items: r.rows, income: inc, expense: exp, balance: inc - exp });
});

app.get('/api/clients', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM clients ORDER BY name');
  res.json(r.rows);
});

app.post('/api/clients', auth, async (req, res) => {
  const { name, email, phone, address, nif } = req.body;
  const r = await pool.query('INSERT INTO clients (name,email,phone,address,nif) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, email || '', phone || '', address || '', nif || '']);
  res.status(201).json(r.rows[0]);
});

app.get('/api/stock', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM products ORDER BY name');
  const items = r.rows.map(p => {
    const tw = parseFloat(p.stock_g || 0) + parseFloat(p.stock_ct || 0) * 0.2;
    const mv = tw * parseFloat(p.price_eur || 0);
    return { ...p, stockValue: (mv * 0.8).toFixed(2), marketPrice: parseFloat(p.price_eur || 0).toFixed(2) };
  });
  res.json(items);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

init().then(() => app.listen(PORT, () => console.log('OK porta ' + PORT)));
