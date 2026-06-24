require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Base de dados PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Criar tabelas
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS materials (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        subtype TEXT,
        stock_grams DECIMAL(10,3) DEFAULT 0,
        stock_carats DECIMAL(10,3) DEFAULT 0,
        unit TEXT DEFAULT 'g'
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        material_id INTEGER REFERENCES materials(id),
        type TEXT NOT NULL,
        weight_grams DECIMAL(10,3),
        weight_carats DECIMAL(10,3),
        price_per_unit DECIMAL(10,2),
        total_price DECIMAL(12,2),
        quality TEXT,
        origin TEXT,
        client_name TEXT,
        payment_method TEXT,
        notes TEXT,
        transaction_date DATE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        address TEXT,
        nif TEXT,
        total_purchases DECIMAL(12,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Criar admin se não existir
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@metaispreciosos.pt';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
    
    const existingAdmin = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    
    if (existingAdmin.rows.length === 0) {
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await client.query(
        'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)',
        ['Administrador', adminEmail, hashedPassword, 'admin']
      );
      console.log('Admin criado:', adminEmail);
    }
    
    console.log('Base de dados inicializada');
  } finally {
    client.release();
  }
}

// Rota de login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    
    if (!user) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'segredo123',
      { expiresIn: '24h' }
    );
    
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Middleware de autenticação
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'segredo123');
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Dashboard
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const stockResult = await pool.query('SELECT COUNT(*) as total FROM materials');
    const totalItems = stockResult.rows[0].total;
    
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const monthResult = await pool.query(
      `SELECT type, SUM(total_price) as total FROM transactions 
       WHERE transaction_date >= $1 GROUP BY type`,
      [monthStart.toISOString().split('T')[0]]
    );
    
    const purchases = monthResult.rows.find(r => r.type === 'purchase')?.total || 0;
    const sales = monthResult.rows.find(r => r.type === 'sale')?.total || 0;
    
    const recentResult = await pool.query(
      `SELECT t.*, m.name as material_name FROM transactions t 
       JOIN materials m ON t.material_id = m.id 
       ORDER BY t.created_at DESC LIMIT 10`
    );
    
    res.json({
      totalItems,
      monthPurchases: purchases,
      monthSales: sales,
      recentTransactions: recentResult.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Listar materiais
app.get('/api/materials', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM materials ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Listar transações
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, m.name as material_name FROM transactions t 
       JOIN materials m ON t.material_id = m.id 
       ORDER BY t.transaction_date DESC, t.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Criar transação
app.post('/api/transactions', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { material_id, type, weight_grams, weight_carats, price_per_unit, total_price, quality, origin, client_name, payment_method, notes, transaction_date } = req.body;
    
    const prefix = type === 'purchase' ? 'COMPRA' : 'VENDA';
    const dateStr = transaction_date.replace(/-/g, '');
    const countResult = await client.query('SELECT COUNT(*) FROM transactions WHERE transaction_date = $1', [transaction_date]);
    const code = `${prefix}-${dateStr}-${(parseInt(countResult.rows[0].count) + 1).toString().padStart(4, '0')}`;
    
    await client.query('BEGIN');
    
    await client.query(
      `INSERT INTO transactions (code, material_id, type, weight_grams, weight_carats, price_per_unit, total_price, quality, origin, client_name, payment_method, notes, transaction_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [code, material_id, type, weight_grams, weight_carats, price_per_unit, total_price, quality, origin, client_name, payment_method, notes, transaction_date]
    );
    
    if (type === 'purchase') {
      await client.query(
        'UPDATE materials SET stock_grams = stock_grams + $1, stock_carats = stock_carats + $2 WHERE id = $3',
        [weight_grams || 0, weight_carats || 0, material_id]
      );
    } else {
      await client.query(
        'UPDATE materials SET stock_grams = stock_grams - $1, stock_carats = stock_carats - $2 WHERE id = $3',
        [weight_grams || 0, weight_carats || 0, material_id]
      );
    }
    
    await client.query('COMMIT');
    
    res.status(201).json({ message: 'Transação registada', code });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao registar transação' });
  } finally {
    client.release();
  }
});

// Listar clientes
app.get('/api/clients', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Criar cliente
app.post('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { name, email, phone, address, nif } = req.body;
    const result = await pool.query(
      'INSERT INTO clients (name, email, phone, address, nif) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, email, phone, address, nif]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar cliente' });
  }
});

// Página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
  });
});